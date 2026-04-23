import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { loadConfig, getAppsDir, resolveAppDbPrefix } from '../config';
import { getDatabaseAdapter } from '../adapters/database';
import { generateSharedEnvFile, deleteTenantAllOverrides } from './envVars';
import { getApp, applyApp } from './app';
import { generateComposeFile } from './composeGenerator';
import { ensureExternalVolumes } from './docker';
import { readManifestFromAppImage, resolveManifestImageRef } from './manifestExtractor';
import { readTenantAppDef, writeTenantAppDef } from './tenantAppDef';
import { AppDefinition, AppDefinitionStatic, AppDefinitionStaticSchema } from '../models/app';
import { assertWithinDir, writeSecretFile } from '../utils/security';
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

  // Validate tenant ID
  if (!validateTenantId(tenantId)) {
    throw new Error('Invalid tenant ID. Must be lowercase alphanumeric with hyphens.');
  }

  // Load app definition first — adapter is scoped to the app's effective db_prefix
  const app = await getApp(appId);
  if (!app) {
    throw new Error(`App '${appId}' not found`);
  }
  const db = getDatabaseAdapter(app);

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

  // Initialize database adapter and create database.
  // Adapter prepends the app's effective db_prefix (empty prefix → no prepend).
  const dbTenantId = `${appId}_${tenantId}`;
  await db.initialize();
  await db.createDatabase(dbTenantId, dbPassword);

  let dbCreated = true;

  const composePath = path.join(tenantPath, 'docker-compose.yml');
  let composeWritten = false;
  try {
    // Generate .env file
    const envContent = generateEnvContent(config, app, tenantId, domain, tag, dbPassword, jwtSecret);
    await writeSecretFile(path.join(tenantPath, '.env'), envContent);

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
    composeWritten = true;

    // Seed this tenant's frozen app-definition snapshot. From v1.5.5 on,
    // per-tenant snapshots drive compose regen + backup config so tenants
    // running different image versions don't step on each other's feet.
    // The snapshot starts as a copy of whatever apps.d/<id>.json says at
    // creation; subsequent updateTenant calls refresh it from the image's
    // embedded manifest when one is present.
    const { createdAt: _cA, updatedAt: _uA, ...appStatic } = app;
    void _cA; void _uA;
    await writeTenantAppDef(appId, tenantId, appStatic as AppDefinitionStatic);

    // Create external volumes and start tenant
    await ensureExternalVolumes(composePath);
    await execFileAsync('docker', ['compose', '--project-directory', tenantPath, '-f', composePath, 'up', '-d']);
  } catch (error) {
    // Rollback in reverse order of creation. If compose was written and `up` was
    // attempted, containers may exist even when the original command failed —
    // always attempt `down -v` so we don't leak them.
    if (composeWritten) {
      await execFileAsync('docker', ['compose', '--project-directory', tenantPath, '-f', composePath, 'down', '-v']).catch(() => {});
    }
    await fs.rm(tenantPath, { recursive: true, force: true }).catch(() => {});
    if (dbCreated) {
      await db.dropDatabase(dbTenantId).catch(() => {});
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
  const tenantPath = getTenantPath(appId, tenantId);
  const app = await getApp(appId);
  const db = getDatabaseAdapter(app ?? undefined);
  const effectivePrefix = resolveAppDbPrefix(app ?? undefined);

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
  // The adapter prepends the app's effective db_prefix, so we pass appId_tenantId as the identifier
  let dbTenantId = `${appId}_${tenantId}`;
  try {
    const envContent = await fs.readFile(path.join(tenantPath, '.env'), 'utf-8');
    const env = parseEnv(envContent);
    if (env.DB_NAME) {
      // Strip the effective prefix if present, since the adapter re-adds it.
      // When the app has an empty prefix, pass DB_NAME through as-is.
      if (effectivePrefix) {
        const prefix = `${effectivePrefix}_`;
        dbTenantId = env.DB_NAME.startsWith(prefix) ? env.DB_NAME.slice(prefix.length) : env.DB_NAME;
      } else {
        dbTenantId = env.DB_NAME;
      }
    }
  } catch {
    // Fall back to constructed name
  }

  // Clean up tenant env var overrides
  await deleteTenantAllOverrides(appId, tenantId);

  // Stop containers. If this fails we refuse to drop the DB — orphaned
  // containers running against a gone DB are worse than an incomplete delete.
  // Caller can retry once the compose issue is resolved.
  let composeDownOk = true;
  try {
    await execFileAsync('docker', ['compose', '--project-directory', tenantPath, '-f', path.join(tenantPath, 'docker-compose.yml'), 'down', '-v']);
  } catch (err: any) {
    composeDownOk = false;
    if (!keepData) {
      throw new Error(
        `Failed to stop tenant containers: ${err?.message || err}. Refusing to drop database — fix and retry.`
      );
    }
    // With keepData=true, containers may already be gone; continue.
    console.warn(`[deleteTenant] compose down failed: ${err?.message || err}. Continuing because keepData=true.`);
  }

  // Drop database unless keeping data
  if (!keepData && composeDownOk) {
    await db.initialize();
    await db.dropDatabase(dbTenantId);
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

  // Load this tenant's current app definition. Prefer the per-tenant
  // snapshot; fall back to apps.d/<id>.json for legacy tenants without
  // a snapshot (boot seeds these, but this keeps the path resilient).
  let app = await readTenantAppDef(appId, tenantId);
  if (!app) {
    throw new Error(`App '${appId}' not found`);
  }

  // Read current .env
  const originalEnvContent = await fs.readFile(envPath, 'utf-8');
  const originalComposeContent = await fs.readFile(composePath, 'utf-8');

  // Update IMAGE_TAG in .env
  const newEnvContent = originalEnvContent.replace(/^IMAGE_TAG=.*/m, `IMAGE_TAG=${newTag}`);
  await writeSecretFile(envPath, newEnvContent);

  // Sync the app definition from the embedded manifest inside the new image,
  // BEFORE we regenerate the compose file — so added/removed services travel
  // atomically with the image release. Best-effort: images without a manifest
  // file, or apps that haven't configured one, keep the existing definition.
  //
  // Two writes per successful extraction:
  //   1. Per-tenant snapshot (drives THIS tenant's compose + backup going
  //      forward — isolates it from sibling tenants on other versions).
  //   2. Global apps.d/<id>.json via applyApp (updates the "latest-seen"
  //      view for the admin UI and as default for new tenants).
  try {
    const manifest = await readManifestFromAppImage(app, newTag);
    if (manifest !== null) {
      const parsed = AppDefinitionStaticSchema.safeParse(manifest);
      if (!parsed.success) {
        const errors = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
        throw new Error(`Image manifest failed validation: ${errors}`);
      }
      await writeTenantAppDef(appId, tenantId, parsed.data);
      const result = await applyApp(parsed.data, `manifest:${resolveManifestImageRef(app, newTag)}`);
      if (result.result === 'updated') {
        console.log(`[manifest] Updated app '${appId}' from image ${newTag} for tenant '${tenantId}' (changed: ${result.changedKeys.join(', ')})`);
      } else if (result.result === 'created') {
        console.log(`[manifest] Created app '${appId}' from image ${newTag} for tenant '${tenantId}'`);
      }
      // Reload so downstream compose regen sees the latest service list.
      const reloaded = await readTenantAppDef(appId, tenantId);
      if (reloaded) app = reloaded;
    }
  } catch (err: any) {
    // Extraction / apply errors are non-fatal for the tag-update path — log
    // loudly and fall through to using the previous definition. This keeps
    // operator-triggered tag bumps working even if the image happens to ship
    // a broken manifest (regression). A broken manifest should be caught by
    // whoever merged it, not block every tenant update across all apps.
    console.warn(`[manifest] Sync skipped for '${appId}'/'${tenantId}' @ ${newTag}: ${err?.message || err}`);
  }

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

  // Pull new images - roll back .env only if pull fails (tag may be invalid)
  try {
    await execFileAsync('docker', ['compose', '--project-directory', tenantPath, '-f', composePath, 'pull']);
    await ensureExternalVolumes(composePath);
  } catch (error) {
    await writeSecretFile(envPath, originalEnvContent);
    await fs.writeFile(composePath, originalComposeContent);
    throw error;
  }

  // Restart containers with new images. --remove-orphans sweeps containers
  // that used to be part of this compose stack but aren't in the regenerated
  // file (e.g. a service removed via an upstream manifest update).
  await execFileAsync('docker', ['compose', '--project-directory', tenantPath, '-f', composePath, 'up', '-d', '--force-recreate', '--remove-orphans']);
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
  const imageRegistry = `${app.registry.url}/${app.registry.repository}`;
  const sharedNetwork = config.networking?.external_network || `${config.project.prefix}-network`;
  const db = getDatabaseAdapter(app);
  const dbName = db.getDatabaseName(`${app.id}_${tenantId}`);

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

# Docker Compose Project Name (must be unique across all apps)
COMPOSE_PROJECT_NAME=${app.id}-${tenantId}

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

