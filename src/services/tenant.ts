import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { loadConfig, getAppsDir, resolveAppDbPrefix } from '../config';
import { resolveCertResolver } from '../config/loader';
import { readTenantTraefik } from './tenantTraefik';
import { getDatabaseAdapter } from '../adapters/database';
import { generateSharedEnvFile, deleteTenantAllOverrides } from './envVars';
import { getApp, applyApp } from './app';
import { generateComposeFile } from './composeGenerator';
import { ensureExternalVolumes } from './docker';
import { readManifestFromAppImage, resolveManifestImageRef } from './manifestExtractor';
import { readTenantAppDef, writeTenantAppDef } from './tenantAppDef';
import { AppDefinition, AppDefinitionStatic, AppDefinitionStaticSchema } from '../models/app';
import { eventBus } from './eventBus';
import type { TenantUpdateProgress, TenantUpdateStep, TenantUpdateStatus } from '../websocket/types';
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

export function validateImageTag(imageTag: unknown): { valid: boolean; error?: string } {
  if (typeof imageTag !== 'string' || imageTag.length === 0) {
    return { valid: false, error: 'imageTag is required' };
  }
  if (imageTag.length > 128) {
    return { valid: false, error: 'imageTag must be 128 characters or less' };
  }
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(imageTag)) {
    return { valid: false, error: 'Invalid imageTag format' };
  }
  return { valid: true };
}

export function validateTenantDomain(domain: unknown): { valid: boolean; error?: string } {
  if (typeof domain !== 'string' || domain.length === 0) {
    return { valid: false, error: 'domain is required' };
  }
  if (domain.length > 253 || /[\s\r\n\0/:]/.test(domain)) {
    return { valid: false, error: 'Invalid domain format' };
  }

  const labels = domain.split('.');
  if (labels.some(label => label.length === 0 || label.length > 63)) {
    return { valid: false, error: 'Invalid domain format' };
  }
  for (const label of labels) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)) {
      return { valid: false, error: 'Invalid domain format' };
    }
  }
  return { valid: true };
}

/**
 * Get the path for a tenant directory: apps/{appId}/tenants/{tenantId}
 */
export function getTenantPath(appId: string, tenantId: string): string {
  return path.join(getAppsDir(), appId, 'tenants', tenantId);
}

/**
 * Pure overlay function — combines a frozen tenant snapshot with the current
 * global app definition's *infrastructure* fields (registry + default_image_tag).
 * Returns the snapshot unchanged if the global is missing.
 *
 * Why this exists (v1.6.8): the frozen-snapshot mechanism (v1.5.5) was
 * designed to isolate tenants from app schema changes — services, backups,
 * env_vars declarations, traefik library — so a tenant on v1.0 doesn't break
 * when v2.0 adds a new service or changes an env var contract. That isolation
 * is correct for those fields. But it also captured `registry` and
 * `default_image_tag`, which are infrastructure decisions ("where do we pull
 * from?", "what tag if none specified?") that should always reflect the
 * current global config — admins changing the source repo expect the change
 * to take effect on existing tenants without reseeding each snapshot.
 */
export function overlayInfrastructure(snapshot: AppDefinition, global: AppDefinition | null): AppDefinition {
  if (!global) return snapshot;
  return {
    ...snapshot,
    registry: global.registry,
    default_image_tag: global.default_image_tag,
  };
}

async function overlayInfrastructureFromGlobal(snapshot: AppDefinition): Promise<AppDefinition> {
  const global = await getApp(snapshot.id);
  return overlayInfrastructure(snapshot, global);
}

function toStaticAppDefinition(app: AppDefinition): AppDefinitionStatic {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...staticDef } = app;
  void _createdAt; void _updatedAt;
  return staticDef as AppDefinitionStatic;
}

export async function createTenant(input: CreateTenantInput): Promise<TenantConfig> {
  const { appId, tenantId, domain, imageTag } = input;
  const config = loadConfig();

  // Validate tenant ID
  if (!validateTenantId(tenantId)) {
    throw new Error('Invalid tenant ID. Must be lowercase alphanumeric with hyphens.');
  }
  const domainValidation = validateTenantDomain(domain);
  if (!domainValidation.valid) {
    throw new Error(domainValidation.error);
  }

  // Load app definition first — adapter is scoped to the app's effective db_prefix
  const app = await getApp(appId);
  if (!app) {
    throw new Error(`App '${appId}' not found`);
  }
  const db = getDatabaseAdapter(app);

  const tag = imageTag || app.default_image_tag || 'latest';
  const tagValidation = validateImageTag(tag);
  if (!tagValidation.valid) {
    throw new Error(tagValidation.error);
  }
  const tenantPath = getTenantPath(appId, tenantId);
  const tenantsDir = path.join(getAppsDir(), appId, 'tenants');
  const dbTenantId = `${appId}_${tenantId}`;
  const composePath = path.join(tenantPath, 'docker-compose.yml');
  let tenantDirCreated = false;
  let dbCreated = false;
  let composeWritten = false;

  try {
    // Atomically create tenant directory — fails if already exists (prevents TOCTOU race)
    await fs.mkdir(tenantsDir, { recursive: true });
    try {
      await fs.mkdir(tenantPath); // NOT recursive — fails if exists
      tenantDirCreated = true;
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
    await db.initialize();
    await db.createDatabase(dbTenantId, dbPassword);
    dbCreated = true;

    // Generate .env file
    const envContent = generateEnvContent(config, app, tenantId, domain, tag, dbPassword, jwtSecret);
    await writeSecretFile(path.join(tenantPath, '.env'), envContent);

    // Generate shared.env for this tenant
    await generateSharedEnvFile(appId, tenantId);

    // Generate docker-compose.yml from app service definitions.
    // Tenant overrides don't exist yet at create-time — they're added later via
    // `PUT /api/apps/:id/tenants/:tid/traefik`. Pass undefined.
    const composeContent = generateComposeFile({
      app,
      tenantId,
      domain,
      config,
      tenantTraefik: undefined,
    });
    await fs.writeFile(path.join(tenantPath, 'docker-compose.yml'), composeContent);
    composeWritten = true;

    // Seed this tenant's frozen app-definition snapshot. From v1.5.5 on,
    // per-tenant snapshots drive compose regen + backup config so tenants
    // running different image versions don't step on each other's feet.
    // The snapshot starts as a copy of whatever apps.d/<id>.json says at
    // creation; subsequent updateTenant calls refresh it from the image's
    // embedded manifest when one is present.
    await writeTenantAppDef(appId, tenantId, toStaticAppDefinition(app));

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
    if (tenantDirCreated) {
      await fs.rm(tenantPath, { recursive: true, force: true }).catch(() => {});
    }
    if (dbCreated) {
      await db.dropDatabase(dbTenantId).catch(() => {});
    }
    if (!tenantDirCreated && error instanceof Error && error.message.includes(`Tenant '${tenantId}' already exists`)) {
      throw error;
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
  const tagValidation = validateImageTag(newTag);
  if (!tagValidation.valid) {
    throw new Error(tagValidation.error);
  }

  const config = loadConfig();
  const tenantPath = getTenantPath(appId, tenantId);
  const envPath = path.join(tenantPath, '.env');
  const sharedEnvPath = path.join(tenantPath, 'shared.env');
  const composePath = path.join(tenantPath, 'docker-compose.yml');

  // Progress emitter — broadcast over WebSocket via eventBus. The admin UI
  // subscribes in the tenant-update modal to render a step-by-step view.
  // Non-throwing: emit failures don't cascade into the update itself.
  const emit = (step: TenantUpdateStep, status: TenantUpdateStatus, detail?: string) => {
    const payload: TenantUpdateProgress = { appId, tenantId, newTag, step, status, detail };
    try { eventBus.emit('tenant:update:progress', payload); } catch { /* swallow */ }
  };

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
  // Overlay infrastructure-level fields (`registry`, `default_image_tag`)
  // from the global definition. The frozen snapshot owns service-level
  // schema (services, backup, env_vars declarations, traefik library) so
  // a tenant on v1.0 doesn't break when v2.0 changes the schema — but
  // *registry* is a "where do we pull from" decision that should always
  // reflect the current global config. Without this, an admin's "switch
  // app to a new repo" edit silently fails to propagate to existing
  // tenants until each is manually reseeded.
  app = await overlayInfrastructureFromGlobal(app);

  // Read current .env
  const originalEnvContent = await fs.readFile(envPath, 'utf-8');
  const originalComposeContent = await fs.readFile(composePath, 'utf-8');
  let originalSharedEnvContent: string | null = null;
  try {
    originalSharedEnvContent = await fs.readFile(sharedEnvPath, 'utf-8');
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }
  const originalTenantAppStatic = toStaticAppDefinition(app);
  const originalGlobalApp = await getApp(appId);
  const originalGlobalAppStatic = originalGlobalApp ? toStaticAppDefinition(originalGlobalApp) : null;
  let manifestApplied = false;

  const restoreAppDefinitions = async () => {
    await writeTenantAppDef(appId, tenantId, originalTenantAppStatic);
    if (manifestApplied && originalGlobalAppStatic) {
      await applyApp(originalGlobalAppStatic, `rollback:${appId}/${tenantId}`);
    }
  };

  const restoreTenantUpdateState = async () => {
    await writeSecretFile(envPath, originalEnvContent);
    if (originalSharedEnvContent === null) {
      await fs.rm(sharedEnvPath, { force: true });
    } else {
      await writeSecretFile(sharedEnvPath, originalSharedEnvContent);
    }
    await fs.writeFile(composePath, originalComposeContent);
    await restoreAppDefinitions();
  };

  const restoreTenantUpdateStateBestEffort = async (context: string) => {
    try {
      await restoreTenantUpdateState();
    } catch (restoreErr: any) {
      console.error(`[tenant:update] Failed to restore ${appId}/${tenantId} after ${context}: ${restoreErr?.message || restoreErr}`);
    }
  };

  // Update IMAGE_TAG in .env
  const newEnvContent = originalEnvContent.replace(/^IMAGE_TAG=.*/m, `IMAGE_TAG=${newTag}`);
  await writeSecretFile(envPath, newEnvContent);

  // Sync the app definition from the embedded manifest inside the new image,
  // BEFORE we regenerate the compose file — so added/removed services travel
  // atomically with the image release.
  emit('manifest', 'started');
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
      manifestApplied = true;
      if (result.result === 'updated') {
        console.log(`[manifest] Updated app '${appId}' from image ${newTag} for tenant '${tenantId}' (changed: ${result.changedKeys.join(', ')})`);
        emit('manifest', 'completed', `updated (changed: ${result.changedKeys.join(', ') || 'none'})`);
      } else if (result.result === 'created') {
        console.log(`[manifest] Created app '${appId}' from image ${newTag} for tenant '${tenantId}'`);
        emit('manifest', 'completed', 'created');
      } else {
        emit('manifest', 'completed', 'noop (manifest matches current definition)');
      }
      const reloaded = await readTenantAppDef(appId, tenantId);
      // Re-apply the overlay: manifest sync can overwrite the registry block
      // with whatever is in the image's embedded /overwatch/app.json, which
      // for older images may carry a stale repo. The global definition is
      // the source of truth for "where do we pull from"; manifest content
      // for that field is ignored.
      if (reloaded) app = await overlayInfrastructureFromGlobal(reloaded);
    } else {
      emit('manifest', 'skipped', 'image carries no /overwatch/app.json — keeping existing definition');
    }
  } catch (err: any) {
    const msg = err?.message || String(err);
    await restoreAppDefinitions().catch((restoreErr: any) => {
      console.error(`[manifest] Failed to restore app definition for '${appId}'/'${tenantId}': ${restoreErr?.message || restoreErr}`);
    });
    console.warn(`[manifest] Sync skipped for '${appId}'/'${tenantId}' @ ${newTag}: ${msg}`);
    emit('manifest', 'skipped', msg);
  }

  // Regenerate shared.env + compose.
  emit('config', 'started');
  try {
    await generateSharedEnvFile(appId, tenantId);

    const domainMatch = originalEnvContent.match(/^TENANT_DOMAIN=(.*)$/m);
    const domain = domainMatch ? domainMatch[1] : '';

    try {
      const tenantTraefik = await readTenantTraefik(appId, tenantId);
      const composeContent = generateComposeFile({ app, tenantId, domain, config, tenantTraefik });
      await fs.writeFile(composePath, composeContent);
    } catch (err) {
      console.warn('Failed to regenerate docker-compose.yml:', err);
      await fs.writeFile(composePath, originalComposeContent);
      throw err;
    }
    emit('config', 'completed');
  } catch (err: any) {
    await restoreTenantUpdateStateBestEffort('config regeneration failure');
    emit('config', 'failed', err?.message || String(err));
    emit('failed', 'failed', err?.message || String(err));
    throw err;
  }

  // Pull new images — usually the slow step. Roll back .env + compose on
  // failure so a bad tag (or missing image, like the classic 'docs:1.3.18
  // not found') leaves the tenant exactly as it was.
  emit('pull', 'started');
  try {
    await execFileAsync('docker', ['compose', '--project-directory', tenantPath, '-f', composePath, 'pull']);
    await ensureExternalVolumes(composePath);
    emit('pull', 'completed');
  } catch (error: any) {
    await restoreTenantUpdateStateBestEffort('pull failure');
    const detail = extractComposeErrorMessage(error);
    emit('pull', 'failed', detail);
    emit('failed', 'failed', detail);
    throw new Error(detail);
  }

  // Restart containers with new images. --remove-orphans sweeps containers
  // that used to be part of this compose stack but aren't in the regenerated
  // file (e.g. a service removed via an upstream manifest update).
  emit('restart', 'started');
  try {
    await execFileAsync('docker', ['compose', '--project-directory', tenantPath, '-f', composePath, 'up', '-d', '--force-recreate', '--remove-orphans']);
    emit('restart', 'completed');
    emit('done', 'completed');
  } catch (error: any) {
    const detail = extractComposeErrorMessage(error);
    await restoreTenantUpdateStateBestEffort('restart failure');
    await execFileAsync('docker', ['compose', '--project-directory', tenantPath, '-f', composePath, 'up', '-d', '--force-recreate']).catch((rollbackErr: any) => {
      console.error(`[tenant:update] Failed to restart restored compose for ${appId}/${tenantId}: ${rollbackErr?.message || rollbackErr}`);
    });
    emit('restart', 'failed', detail);
    emit('failed', 'failed', detail);
    throw new Error(detail);
  }
}

/**
 * `docker compose` stuffs the useful error into `stderr` along with a lot of
 * progress noise. Pull out the "Error:" line when present; fall back to the
 * exec error message.
 */
function extractComposeErrorMessage(error: any): string {
  const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
  const errorLine = stderr.split('\n').find((l: string) => /^Error\s/i.test(l) || /^Error\s+response/i.test(l));
  if (errorLine) return errorLine.trim();
  // Fallback: first non-empty non-"Pulling"/"Pulled" line of stderr.
  for (const raw of stderr.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\w+\s+(Pulling|Pulled|Skipped|Interrupted)/i.test(line)) continue;
    return line;
  }
  return error?.message || String(error);
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

  // Resolve cert resolver via the new `traefik.cert_resolvers` model.
  // The loader-level shim synthesizes this from the legacy `networking.cert_resolvers`
  // for installs that haven't migrated yet — both paths share the same resolution code.
  let certResolver: string;
  try {
    certResolver = resolveCertResolver(domain, config.traefik).name;
  } catch {
    // Fall back to legacy domain-pattern matching when the resolver helper can't
    // pick one (e.g. no http fallback resolver configured) — keeps tenant create
    // working on partially-configured installs while the operator finishes setup.
    const certResolvers = config.networking?.cert_resolvers;
    if (app.domain_template.startsWith('*.')) {
      const baseDomain = app.domain_template.slice(2);
      certResolver = domain.endsWith(`.${baseDomain}`)
        ? (certResolvers?.wildcard || 'letsencrypt')
        : (certResolvers?.default || 'letsencrypt-http');
    } else {
      certResolver = certResolvers?.default || 'letsencrypt-http';
    }
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
