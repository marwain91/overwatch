import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { loadConfig, getDatabasePrefix, getTenantsDir } from '../config';
import { getDatabaseAdapter } from '../adapters/database';

const execAsync = promisify(exec);

function getTemplateDir(): string {
  const config = loadConfig();
  return process.env.TEMPLATE_DIR || config.tenant_template?.dir || './tenant-template';
}

export interface CreateTenantInput {
  tenantId: string;
  domain: string;
  imageTag?: string;
}

export interface TenantConfig {
  tenantId: string;
  domain: string;
  imageTag: string;
  createdAt: string;
}

function generatePassword(length: number): string {
  return crypto.randomBytes(length).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, length);
}

function validateTenantId(tenantId: string): boolean {
  return /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(tenantId);
}

export async function createTenant(input: CreateTenantInput): Promise<TenantConfig> {
  const { tenantId, domain, imageTag = 'latest' } = input;
  const config = loadConfig();
  const db = getDatabaseAdapter();
  const dbPrefix = getDatabasePrefix();

  // Validate tenant ID
  if (!validateTenantId(tenantId)) {
    throw new Error('Invalid tenant ID. Must be lowercase alphanumeric with hyphens.');
  }

  const tenantsDir = getTenantsDir();
  const tenantPath = path.join(tenantsDir, tenantId);

  // Check if tenant already exists
  try {
    await fs.access(tenantPath);
    throw new Error(`Tenant '${tenantId}' already exists`);
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }

  // Get credential lengths from config
  const dbPasswordLength = config.credentials?.db_password_length || 32;
  const jwtSecretLength = config.credentials?.jwt_secret_length || 64;

  // Generate credentials
  const dbPassword = generatePassword(dbPasswordLength);
  const jwtSecret = generatePassword(jwtSecretLength);

  // Initialize database adapter and create database
  await db.initialize();
  await db.createDatabase(tenantId, dbPassword);

  // Create tenant directory
  await fs.mkdir(tenantPath, { recursive: true });

  // Generate .env file using config values
  const envContent = generateEnvContent(config, tenantId, domain, imageTag, dbPassword, jwtSecret);
  await fs.writeFile(path.join(tenantPath, '.env'), envContent);

  // Copy docker-compose template
  const templateDir = getTemplateDir();
  const composeFile = config.tenant_template?.compose_file || 'docker-compose.yml';
  const templateContent = await fs.readFile(
    path.join(templateDir, composeFile),
    'utf-8'
  );
  await fs.writeFile(path.join(tenantPath, 'docker-compose.yml'), templateContent);

  // Start tenant
  try {
    await execAsync(`docker compose -f ${tenantPath}/docker-compose.yml up -d`);
  } catch (error) {
    // Cleanup on failure
    await fs.rm(tenantPath, { recursive: true, force: true });
    await db.dropDatabase(tenantId);
    throw new Error(`Failed to start tenant containers: ${error}`);
  }

  return {
    tenantId,
    domain,
    imageTag,
    createdAt: new Date().toISOString(),
  };
}

export async function deleteTenant(tenantId: string, keepData: boolean = false): Promise<void> {
  const tenantsDir = getTenantsDir();
  const tenantPath = path.join(tenantsDir, tenantId);
  const db = getDatabaseAdapter();

  // Check if tenant exists
  try {
    await fs.access(tenantPath);
  } catch {
    throw new Error(`Tenant '${tenantId}' not found`);
  }

  // Stop containers
  try {
    await execAsync(`docker compose -f ${tenantPath}/docker-compose.yml down -v`);
  } catch {
    // Ignore errors
  }

  // Drop database unless keeping data
  if (!keepData) {
    await db.initialize();
    await db.dropDatabase(tenantId);
  }

  // Remove tenant directory
  await fs.rm(tenantPath, { recursive: true, force: true });
}

export async function updateTenant(tenantId: string, newTag: string): Promise<void> {
  const tenantsDir = getTenantsDir();
  const templateDir = getTemplateDir();
  const config = loadConfig();

  const tenantPath = path.join(tenantsDir, tenantId);
  const envPath = path.join(tenantPath, '.env');
  const composePath = path.join(tenantPath, 'docker-compose.yml');

  // Check if tenant exists
  try {
    await fs.access(envPath);
  } catch {
    throw new Error(`Tenant '${tenantId}' not found`);
  }

  // Read current .env and extract old IMAGE_TAG
  const originalEnvContent = await fs.readFile(envPath, 'utf-8');

  // Backup current docker-compose.yml
  const originalComposeContent = await fs.readFile(composePath, 'utf-8');

  // Update IMAGE_TAG in .env
  const newEnvContent = originalEnvContent.replace(/^IMAGE_TAG=.*/m, `IMAGE_TAG=${newTag}`);
  await fs.writeFile(envPath, newEnvContent);

  // Update docker-compose.yml from template (picks up any template changes)
  try {
    const composeFile = config.tenant_template?.compose_file || 'docker-compose.yml';
    const templateContent = await fs.readFile(
      path.join(templateDir, composeFile),
      'utf-8'
    );
    await fs.writeFile(composePath, templateContent);
  } catch (err) {
    // If template copy fails, restore original and continue with old compose file
    console.warn('Failed to update docker-compose.yml from template:', err);
    await fs.writeFile(composePath, originalComposeContent);
  }

  // Pull new images and restart - restore old files on failure
  try {
    await execAsync(`docker compose -f ${composePath} pull`);
    await execAsync(`docker compose -f ${composePath} up -d --force-recreate`);
  } catch (error) {
    // Restore old .env and docker-compose.yml since deployment failed
    await fs.writeFile(envPath, originalEnvContent);
    await fs.writeFile(composePath, originalComposeContent);
    throw error;
  }
}

export async function getTenantConfig(tenantId: string): Promise<TenantConfig | null> {
  const tenantsDir = getTenantsDir();
  const tenantPath = path.join(tenantsDir, tenantId);
  const envPath = path.join(tenantPath, '.env');

  try {
    const envContent = await fs.readFile(envPath, 'utf-8');
    const env = parseEnv(envContent);

    return {
      tenantId,
      domain: env.TENANT_DOMAIN || '',
      imageTag: env.IMAGE_TAG || 'latest',
      createdAt: '', // Not stored in .env
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
  tenantId: string,
  domain: string,
  imageTag: string,
  dbPassword: string,
  jwtSecret: string
): string {
  const dbPrefix = config.project.db_prefix;
  const registry = config.registry;

  return `# ${config.project.name} Tenant Configuration
# Tenant: ${tenantId}
# Generated: ${new Date().toISOString()}

# Tenant Identification
TENANT_ID=${tenantId}
TENANT_DOMAIN=${domain}

# Container Image Configuration
GITHUB_REPO=${registry.repository}
IMAGE_TAG=${imageTag}

# Database Configuration
DB_NAME=${dbPrefix}_${tenantId}
DB_USER=${dbPrefix}_${tenantId}
DB_PASSWORD=${dbPassword}

# Application Security
JWT_SECRET=${jwtSecret}
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
