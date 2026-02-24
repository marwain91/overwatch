import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { loadConfig, getDatabasePrefix, getAppsDir } from '../config';
import { getDatabaseAdapter } from '../adapters/database';
import { generateSharedEnvFile, deleteTenantAllOverrides } from './envVars';
import { getApp } from './app';
import { generateComposeFile } from './composeGenerator';
import { AppDefinition } from '../models/app';

const execFileAsync = promisify(execFile);

export interface CreateTenantInput {
  appId: string;
  tenantId: string;
  domain: string;
  imageTag?: string;
}

export interface TenantConfig {
  appId: string;
  tenantId: string;
  domain: string;
  imageTag: string;
  createdAt: string;
}

function generatePassword(length: number): string {
  return crypto.randomBytes(length).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, length);
}

function validateTenantId(tenantId: string): boolean {
  return tenantId.length <= 63 && /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(tenantId);
}

/**
 * Get the path for a tenant directory: apps/{appId}/tenants/{tenantId}
 */
export function getTenantPath(appId: string, tenantId: string): string {
  return path.join(getAppsDir(), appId, 'tenants', tenantId);
}

export async function createTenant(input: CreateTenantInput): Promise<TenantConfig> {
  const { appId, tenantId, domain, imageTag } = input;
  const config = loadConfig();
  const db = getDatabaseAdapter();
  const dbPrefix = getDatabasePrefix();

  // Validate tenant ID
  if (!validateTenantId(tenantId)) {
    throw new Error('Invalid tenant ID. Must be lowercase alphanumeric with hyphens.');
  }

  // Load app definition
  const app = await getApp(appId);
  if (!app) {
    throw new Error(`App '${appId}' not found`);
  }

  const tag = imageTag || app.default_image_tag || 'latest';
  const tenantPath = getTenantPath(appId, tenantId);

  // Check if tenant already exists
  try {
    await fs.access(tenantPath);
    throw new Error(`Tenant '${tenantId}' already exists in app '${appId}'`);
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }

  // Get credential lengths from app or global config
  const dbPasswordLength = app.credentials?.db_password_length || config.credentials?.db_password_length || 32;
  const jwtSecretLength = app.credentials?.jwt_secret_length || config.credentials?.jwt_secret_length || 64;

  // Generate credentials
  const dbPassword = generatePassword(dbPasswordLength);
  const jwtSecret = generatePassword(jwtSecretLength);

  // Initialize database adapter and create database
  // DB name: {db_prefix}_{appId}_{tenantId}
  const dbName = `${dbPrefix}_${appId}_${tenantId}`;
  await db.initialize();
  await db.createDatabase(dbName, dbPassword);

  let dbCreated = true;

  try {
    // Create tenant directory
    await fs.mkdir(tenantPath, { recursive: true });

    // Generate .env file
    const envContent = generateEnvContent(config, app, tenantId, domain, tag, dbPassword, jwtSecret);
    await fs.writeFile(path.join(tenantPath, '.env'), envContent);

    // Generate shared.env for this tenant
    await generateSharedEnvFile(appId, tenantId);

    // Generate docker-compose.yml from app service definitions
    const composeContent = generateComposeFile({
      app,
      tenantId,
      domain,
      config,
    });
    await fs.writeFile(path.join(tenantPath, 'docker-compose.yml'), composeContent);

    // Start tenant
    await execFileAsync('docker', ['compose', '-f', path.join(tenantPath, 'docker-compose.yml'), 'up', '-d']);
  } catch (error) {
    // Cleanup on failure - remove directory and database
    await fs.rm(tenantPath, { recursive: true, force: true }).catch(() => {});
    if (dbCreated) {
      await db.dropDatabase(dbName).catch(() => {});
    }
    throw new Error(`Failed to create tenant: ${error instanceof Error ? error.message : error}`);
  }

  return {
    appId,
    tenantId,
    domain,
    imageTag: tag,
    createdAt: new Date().toISOString(),
  };
}

export async function deleteTenant(appId: string, tenantId: string, keepData: boolean = false): Promise<void> {
  const dbPrefix = getDatabasePrefix();
  const tenantPath = getTenantPath(appId, tenantId);
  const db = getDatabaseAdapter();

  // Check if tenant exists
  try {
    await fs.access(tenantPath);
  } catch {
    throw new Error(`Tenant '${tenantId}' not found in app '${appId}'`);
  }

  // Read DB_NAME from tenant .env (may differ from constructed name for migrated tenants)
  let dbName = `${dbPrefix}_${appId}_${tenantId}`;
  try {
    const envContent = await fs.readFile(path.join(tenantPath, '.env'), 'utf-8');
    const env = parseEnv(envContent);
    if (env.DB_NAME) {
      dbName = env.DB_NAME;
    }
  } catch {
    // Fall back to constructed name
  }

  // Clean up tenant env var overrides
  await deleteTenantAllOverrides(appId, tenantId);

  // Stop containers
  try {
    await execFileAsync('docker', ['compose', '-f', path.join(tenantPath, 'docker-compose.yml'), 'down', '-v']);
  } catch {
    // Ignore errors
  }

  // Drop database unless keeping data
  if (!keepData) {
    await db.initialize();
    await db.dropDatabase(dbName);
  }

  // Remove tenant directory
  await fs.rm(tenantPath, { recursive: true, force: true });
}

export async function updateTenant(appId: string, tenantId: string, newTag: string): Promise<void> {
  const tenantPath = getTenantPath(appId, tenantId);
  const envPath = path.join(tenantPath, '.env');
  const composePath = path.join(tenantPath, 'docker-compose.yml');

  // Check if tenant exists
  try {
    await fs.access(envPath);
  } catch {
    throw new Error(`Tenant '${tenantId}' not found in app '${appId}'`);
  }

  // Read current .env
  const originalEnvContent = await fs.readFile(envPath, 'utf-8');

  // Update IMAGE_TAG in .env
  const newEnvContent = originalEnvContent.replace(/^IMAGE_TAG=.*/m, `IMAGE_TAG=${newTag}`);
  await fs.writeFile(envPath, newEnvContent);

  // Regenerate shared.env
  await generateSharedEnvFile(appId, tenantId);

  // Pull new images and restart - restore .env on failure
  try {
    await execFileAsync('docker', ['compose', '-f', composePath, 'pull']);
    await execFileAsync('docker', ['compose', '-f', composePath, 'up', '-d', '--force-recreate']);
  } catch (error) {
    await fs.writeFile(envPath, originalEnvContent);
    throw error;
  }
}

export async function getTenantConfig(appId: string, tenantId: string): Promise<TenantConfig | null> {
  const tenantPath = getTenantPath(appId, tenantId);
  const envPath = path.join(tenantPath, '.env');

  try {
    const envContent = await fs.readFile(envPath, 'utf-8');
    const env = parseEnv(envContent);

    return {
      appId,
      tenantId,
      domain: env.TENANT_DOMAIN || '',
      imageTag: env.IMAGE_TAG || 'latest',
      createdAt: '',
    };
  } catch {
    return null;
  }
}

/**
 * Generate .env content for a tenant using configuration
 */
function generateEnvContent(
  config: ReturnType<typeof loadConfig>,
  app: AppDefinition,
  tenantId: string,
  domain: string,
  imageTag: string,
  dbPassword: string,
  jwtSecret: string
): string {
  const dbPrefix = config.project.db_prefix;
  const imageRegistry = `${app.registry.url}/${app.registry.repository}`;
  const sharedNetwork = config.networking?.external_network || `${config.project.prefix}-network`;
  const dbName = `${dbPrefix}_${app.id}_${tenantId}`;

  return `# ${config.project.name} Tenant Configuration
# App: ${app.id} (${app.name})
# Tenant: ${tenantId}
# Generated: ${new Date().toISOString()}

# App Identification
APP_ID=${app.id}

# Tenant Identification
TENANT_ID=${tenantId}
TENANT_DOMAIN=${domain}

# Container Image Configuration
IMAGE_REGISTRY=${imageRegistry}
IMAGE_TAG=${imageTag}

# Project Configuration
PROJECT_PREFIX=${config.project.prefix}

# Database Configuration
DB_HOST=${config.database.host}
DB_PORT=${config.database.port}
DB_NAME=${dbName}
DB_USER=${dbName}
DB_PASSWORD=${dbPassword}

# Application Security
JWT_SECRET=${jwtSecret}

# Network Configuration
SHARED_NETWORK=${sharedNetwork}
`;
}

function parseEnv(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const [key, ...valueParts] = trimmed.split('=');
    if (key && valueParts.length > 0) {
      env[key] = valueParts.join('=');
    }
  }

  return env;
}
