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
import { assertWithinDir } from '../utils/security';
import { isValidSlug } from '../utils/validators';
import { parseEnv } from '../utils/env';

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
  return isValidSlug(tenantId);
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

  // Atomically create tenant directory — fails if already exists (prevents TOCTOU race)
  const tenantsDir = path.join(getAppsDir(), appId, 'tenants');
  await fs.mkdir(tenantsDir, { recursive: true });
  try {
    await fs.mkdir(tenantPath); // NOT recursive — fails if exists
  } catch (err: any) {
    if (err.code === 'EEXIST') {
      throw new Error(`Tenant '${tenantId}' already exists in app '${appId}'`);
    }
    throw err;
  }

  // Verify the path hasn't been manipulated via symlinks
  await assertWithinDir(tenantPath, tenantsDir);

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

  // Verify path hasn't been manipulated via symlinks
  const appsDir = getAppsDir();
  await assertWithinDir(tenantPath, appsDir);

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
  const config = loadConfig();
  const tenantPath = getTenantPath(appId, tenantId);
  const envPath = path.join(tenantPath, '.env');
  const composePath = path.join(tenantPath, 'docker-compose.yml');

  // Check if tenant exists
  try {
    await fs.access(envPath);
  } catch {
    throw new Error(`Tenant '${tenantId}' not found in app '${appId}'`);
  }

  // Verify path hasn't been manipulated via symlinks
  await assertWithinDir(tenantPath, getAppsDir());

  // Load app definition
  const app = await getApp(appId);
  if (!app) {
    throw new Error(`App '${appId}' not found`);
  }

  // Read current .env
  const originalEnvContent = await fs.readFile(envPath, 'utf-8');
  const originalComposeContent = await fs.readFile(composePath, 'utf-8');

  // Update IMAGE_TAG in .env
  const newEnvContent = originalEnvContent.replace(/^IMAGE_TAG=.*/m, `IMAGE_TAG=${newTag}`);
  await fs.writeFile(envPath, newEnvContent);

  // Regenerate shared.env
  await generateSharedEnvFile(appId, tenantId);

  // Extract domain from .env
  const domainMatch = originalEnvContent.match(/^TENANT_DOMAIN=(.*)$/m);
  const domain = domainMatch ? domainMatch[1] : '';

  // Regenerate docker-compose.yml from app definitions
  try {
    const composeContent = generateComposeFile({
      app,
      tenantId,
      domain,
      config,
    });
    await fs.writeFile(composePath, composeContent);
  } catch (err) {
    console.warn('Failed to regenerate docker-compose.yml:', err);
    await fs.writeFile(composePath, originalComposeContent);
  }

  // Pull new images and restart - restore old files on failure
  try {
    await execFileAsync('docker', ['compose', '-f', composePath, 'pull']);
    await execFileAsync('docker', ['compose', '-f', composePath, 'up', '-d', '--force-recreate']);
  } catch (error) {
    await fs.writeFile(envPath, originalEnvContent);
    await fs.writeFile(composePath, originalComposeContent);
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

  // Determine cert resolver based on domain matching
  const certResolvers = config.networking?.cert_resolvers;
  let certResolver: string;
  if (app.domain_template.startsWith('*.')) {
    const baseDomain = app.domain_template.slice(2);
    if (domain.endsWith(`.${baseDomain}`)) {
      certResolver = certResolvers?.wildcard || 'letsencrypt';
    } else {
      certResolver = certResolvers?.default || 'letsencrypt-http';
    }
  } else {
    certResolver = certResolvers?.default || 'letsencrypt-http';
  }

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

# TLS Configuration
CERT_RESOLVER=${certResolver}
`;
}

