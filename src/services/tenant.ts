import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { loadConfig, getDataDir } from '../config';
import { resolveCertResolver } from '../config/loader';
import { readTenantTraefik, assertTenantDomainAllowed } from './tenantTraefik';
import { getDatabaseAdapter } from '../adapters/database';
import { generateSharedEnvFile, deleteTenantAllOverrides, formatEnvValue } from './envVars';
import { getApp, applyApp } from './app';
import { generateComposeFile, readComposeNames, protectUnownedVolumes } from './composeGenerator';
import { ensureExternalVolumes } from './docker';
import { readManifestFromAppImage, resolveManifestImageRef } from './manifestExtractor';
import { applyManifestPolicy, manifestPolicyBaseline } from './manifestPolicy';
import { writeTenantAppDef, resolveTenantApp, overlayGlobalApp } from './tenantAppDef';
import { describeFailedInitContainers } from './initContainerDiagnostics';
import { AppDefinition, AppDefinitionStatic, AppDefinitionStaticSchema } from '../models/app';
import { eventBus } from './eventBus';
import type { TenantUpdateProgress, TenantUpdateStep, TenantUpdateStatus } from './eventBus';
import { assertWithinDir, writeSecretFile } from '../utils/security';
import { tenantDir, tenantsDir, assertTenantDir, listTenantDirs, parseTenantEnv } from './tenantStore';
import { tenantIdentity, findIdentityConflict, assertTenantDbName, isTenantOwnedVolume, type TenantIdentity, type TenantNames } from './tenantIdentity';
import { SLUG_RE } from '../utils/validators';
import { resolveTenantDbName } from './tenantDb';
import { runDocker } from '../utils/runDocker';
import { writeFileAtomic } from '../utils/atomicJson';
import { withFileLock, withTenantLock } from './fileLock';
import { isDeepStrictEqual } from 'util';
import { extractComposeErrorMessage } from '../utils/composeErrors';
import { ConflictError, HttpError, NotFoundError, ValidationError } from '../utils/httpErrors';
import { COMPOSE_LONG_TIMEOUT_MS } from './composeTimeouts';

// runDocker gives every call the curated env (compose resolves ${VAR} against
// its own environment, and Overwatch's holds operator secrets) and a timeout,
// so a hung daemon or a registry stall cannot pin the tenant lock forever.
const COMPOSE_TIMEOUT_MS = 300_000;
const execDocker = (args: string[], timeoutMs: number = COMPOSE_TIMEOUT_MS) =>
  runDocker('docker', args, { timeoutMs });

export interface CreateTenantInput {
  appId: string;
  tenantId: string;
  domain: string;
  imageTag?: string;
  /**
   * false: create the containers (`compose create`) without starting them, so a
   * caller can load data before the app first runs. Default true (`up -d`).
   */
  start?: boolean;
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
  return tenantDir(appId, tenantId);
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

function toStaticAppDefinition(app: AppDefinition): AppDefinitionStatic {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...staticDef } = app;
  void _createdAt; void _updatedAt;
  return staticDef as AppDefinitionStatic;
}

/** The names a tenant being created would use, read back from its generated compose file. */
function candidateNames(identity: TenantIdentity, dbName: string, composeContent: string): TenantNames {
  const { containerNames, volumes } = readComposeNames(composeContent);
  return {
    appId: identity.appId,
    tenantId: identity.tenantId,
    composeProject: identity.composeProject,
    namePrefix: identity.namePrefix,
    dbName,
    containerNames,
    // Shared (external) volumes are shared on purpose; only owned ones must be unique.
    volumeNames: volumes.filter(v => !v.external && isTenantOwnedVolume(v.name, identity.appId, identity.tenantId)).map(v => v.name),
  };
}

/**
 * Names every existing tenant uses: the compose project and database from its
 * .env (what it actually runs with), containers and volumes from its compose
 * file. A .env that exists but cannot be read fails the check (closed).
 */
async function existingTenantNames(): Promise<TenantNames[]> {
  const refs = await listTenantDirs();
  return Promise.all(refs.map(async ({ appId, tenantId, dir }): Promise<TenantNames> => {
    const identity = tenantIdentity(appId, tenantId);
    let env: Record<string, string> = {};
    try {
      env = parseTenantEnv(await fs.readFile(path.join(dir, '.env'), 'utf-8'));
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        throw new HttpError(500, `Cannot check tenant names: the .env of ${appId}/${tenantId} could not be read (${err?.code || err?.message || err})`, { expose: true });
      }
    }
    const names: TenantNames = {
      appId,
      tenantId,
      composeProject: env.COMPOSE_PROJECT_NAME || identity.composeProject,
      namePrefix: identity.namePrefix,
      dbName: env.DB_NAME || undefined,
    };
    try {
      const { containerNames, volumes } = readComposeNames(await fs.readFile(path.join(dir, 'docker-compose.yml'), 'utf-8'));
      names.containerNames = containerNames;
      names.volumeNames = volumes.map(v => v.name);
    } catch {
      // No readable compose file: the project, prefix and database checks still apply.
    }
    return names;
  }));
}

export function createTenant(input: CreateTenantInput): Promise<TenantConfig> {
  return withTenantLock(String(input.appId), String(input.tenantId), () => createTenantLocked(input));
}

/** Caller must hold the tenant lock (withTenantLock) for appId/tenantId. */
export async function createTenantLocked(input: CreateTenantInput): Promise<TenantConfig> {
  const { domain, imageTag } = input;
  const config = loadConfig();

  // Extract appId/tenantId via regex match so the values used below are the
  // captured strings, not the raw inputs. Route middleware already enforces
  // the slug format; this duplicate check is defense in depth for CLI callers
  // and breaks taint flow into path.join for static analysis.
  const appIdMatch = input.appId.match(SLUG_RE);
  if (!appIdMatch) {
    throw new ValidationError('Invalid app ID. Must be lowercase alphanumeric with hyphens.');
  }
  const appId = appIdMatch[0];
  const tenantIdMatch = input.tenantId.match(SLUG_RE);
  if (!tenantIdMatch) {
    throw new ValidationError('Invalid tenant ID. Must be lowercase alphanumeric with hyphens.');
  }
  const tenantId = tenantIdMatch[0];
  const domainValidation = validateTenantDomain(domain);
  if (!domainValidation.valid) {
    throw new ValidationError(domainValidation.error!);
  }

  // Load app definition first — adapter is scoped to the app's effective db_prefix
  const app = await getApp(appId);
  if (!app) {
    throw new NotFoundError(`App '${appId}' not found`);
  }
  const tag = imageTag || app.default_image_tag || 'latest';
  const tagValidation = validateImageTag(tag);
  if (!tagValidation.valid) {
    throw new ValidationError(tagValidation.error!);
  }
  const db = getDatabaseAdapter(app);
  const tenantPath = getTenantPath(appId, tenantId);
  const appTenantsDir = tenantsDir(appId);
  const identity = tenantIdentity(appId, tenantId);
  const dbTenantId = identity.dbId;
  const dbName = db.getDatabaseName(dbTenantId);
  // A name the database server would refuse fails here, before anything exists.
  assertTenantDbName(dbName, config.database?.type);
  const composePath = path.join(tenantPath, 'docker-compose.yml');
  let tenantDirCreated = false;
  let dbCreated = false;
  let userCreated = false;
  let upAttempted = false;

  try {
    await fs.mkdir(appTenantsDir, { recursive: true });

    // Credentials are generated up front so the tenant .env (which is what makes
    // the domain visible to other creates) can be written inside the domain lock.
    const dbPasswordLength = app.credentials?.db_password_length || config.credentials?.db_password_length || 32;
    const jwtSecretLength = app.credentials?.jwt_secret_length || config.credentials?.jwt_secret_length || 64;
    const dbPassword = generatePassword(dbPasswordLength);
    const jwtSecret = generatePassword(jwtSecretLength);

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
    const candidate = candidateNames(identity, dbName, composeContent);

    // The domain and name checks read other tenants' files, so the checks and
    // the write of this tenant's .env and compose file must be one step: two
    // concurrent creates would otherwise both pass.
    await withFileLock('tenant-domains', async () => {
      // Reserved Overwatch hosts and other tenants' domains/aliases (create-from-backup goes through here too).
      await assertTenantDomainAllowed(appId, tenantId, domain);
      const conflict = findIdentityConflict(candidate, await existingTenantNames());
      if (conflict) {
        throw new ConflictError(`Tenant '${tenantId}' cannot be created in app '${appId}': ${conflict}. Choose a different tenant ID.`);
      }

      // Atomically create tenant directory — fails if already exists (prevents TOCTOU race)
      try {
        await fs.mkdir(tenantPath); // NOT recursive — fails if exists
        tenantDirCreated = true;
      } catch (err: any) {
        if (err.code === 'EEXIST') {
          throw new ConflictError(`Tenant '${tenantId}' already exists in app '${appId}'`);
        }
        throw err;
      }

      // Verify the path hasn't been manipulated via symlinks
      await assertWithinDir(tenantPath, appTenantsDir);

      const envContent = generateEnvContent(config, app, identity, dbName, domain, tag, dbPassword, jwtSecret);
      await writeSecretFile(path.join(tenantPath, '.env'), envContent);
      await fs.writeFile(composePath, composeContent);
    });

    // Initialize database adapter and create database.
    // Adapter prepends the app's effective db_prefix (empty prefix → no prepend).
    await db.initialize();
    // Never adopt a database that already exists: a later rollback would drop it.
    if (await db.databaseExists(dbTenantId)) {
      throw new ConflictError(
        `A database '${dbName}' already exists on the database server, so tenant '${tenantId}' cannot be created: ` +
        'Overwatch never adopts an existing database. If a tenant with this ID was deleted with "Keep data", ' +
        `its database and volumes were kept on purpose and its .env (with the database password) was saved under deleted-tenants/${appId}/ in the Overwatch data directory. ` +
        `To create the tenant again, back up and drop the database '${dbName}' and its user on the database server; ` +
        `its kept volumes (${identity.namePrefix}*) are reused unless you remove them.`,
      );
    }
    const dbResult = await db.createDatabase(dbTenantId, dbPassword);
    dbCreated = dbResult.created;
    userCreated = dbResult.userCreated;

    // Generate shared.env for this tenant (we hold the tenant lock)
    await generateSharedEnvFile(appId, tenantId, { alreadyLocked: true });

    // Seed this tenant's frozen app-definition snapshot. From v1.5.5 on,
    // per-tenant snapshots drive compose regen + backup config so tenants
    // running different image versions don't step on each other's feet.
    // The snapshot starts as a copy of whatever apps.d/<id>.json says at
    // creation; subsequent updateTenant calls refresh it from the image's
    // embedded manifest when one is present.
    await writeTenantAppDef(appId, tenantId, toStaticAppDefinition(app));

    // Create external volumes and start tenant
    await ensureExternalVolumes(composePath);
    upAttempted = true;
    await execDocker(
      ['compose', '--project-directory', tenantPath, '-f', composePath, input.start === false ? 'create' : 'up', ...(input.start === false ? [] : ['-d'])],
      COMPOSE_LONG_TIMEOUT_MS,
    );
  } catch (error) {
    // Rollback in reverse order of creation. If `up` was attempted, containers
    // may exist even when the original command failed — always attempt `down`
    // so we don't leak them. Without -v: the tenant's volumes may predate this
    // create (kept by an earlier "keep data" delete of the same tenant ID).
    // Gather init container evidence first: `down` deletes the containers
    // whose logs explain a failed first migration.
    let initFailures = '';
    if (upAttempted) {
      initFailures = await describeFailedInitContainers(app, tenantId).catch(() => '');
      await execDocker(['compose', '--project-directory', tenantPath, '-f', composePath, 'down']).catch(() => {});
    }
    if (tenantDirCreated) {
      await fs.rm(tenantPath, { recursive: true, force: true }).catch(() => {});
    }
    if (dbCreated) {
      await db.dropDatabase(dbTenantId, { keepUser: !userCreated }).catch(() => {});
    }
    if (error instanceof ConflictError || error instanceof ValidationError) {
      throw error;
    }
    const reason = extractComposeErrorMessage(error);
    throw new HttpError(500, `Failed to create tenant: ${reason}${initFailures ? `\n\n${initFailures}` : ''}`, { expose: true });
  }

  return {
    appId,
    tenantId,
    domain,
    imageTag: tag,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Start the containers of a tenant created with `start: false`. `--no-recreate`
 * keeps the containers that data was copied into; `up` also runs the init
 * containers. Caller must hold the tenant lock. Failure evidence from init
 * containers is added to the error; the caller decides about rollback.
 */
export async function startCreatedTenantLocked(appId: string, tenantId: string): Promise<void> {
  const tenantPath = await assertTenantDir(appId, tenantId);
  const composePath = path.join(tenantPath, 'docker-compose.yml');
  try {
    await ensureExternalVolumes(composePath);
    await execDocker(['compose', '--project-directory', tenantPath, '-f', composePath, 'up', '-d', '--no-recreate'], COMPOSE_LONG_TIMEOUT_MS);
  } catch (error) {
    const app = await resolveTenantApp(appId, tenantId).catch(() => null);
    const initFailures = app ? await describeFailedInitContainers(app, tenantId).catch(() => '') : '';
    throw new HttpError(500, `${extractComposeErrorMessage(error)}${initFailures ? `\n\n${initFailures}` : ''}`, { expose: true });
  }
}

/**
 * Before `down -v`: a compose file written before tenant-scoped volume names
 * can declare unscoped volumes other tenants share. Rewrite them as external
 * so compose removes only the tenant's own volumes.
 */
async function guardUnownedVolumes(composePath: string, appId: string, tenantId: string): Promise<void> {
  let text: string;
  try {
    text = await fs.readFile(composePath, 'utf-8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
  let guarded: string | null;
  try {
    guarded = protectUnownedVolumes(text, appId, tenantId);
  } catch (err: any) {
    throw new HttpError(
      500,
      `Cannot read the docker-compose.yml of ${appId}/${tenantId} (${err?.message || err}), so its volumes cannot be told apart from shared ones. Refusing to delete them; fix the file and retry.`,
      { expose: true },
    );
  }
  if (guarded !== null) {
    console.warn(`[deleteTenant] ${appId}/${tenantId}: keeping volumes the tenant does not own (shared legacy volumes)`);
    await writeFileAtomic(composePath, guarded);
  }
}

/**
 * "Keep data" keeps the database and the volumes, so keep the credentials to
 * them as well: the tenant's .env (database password, JWT secret) is copied to
 * <dataDir>/deleted-tenants/<appId>/<tenantId>-<timestamp>.env, mode 0600.
 * Runs before anything is torn down; if the copy fails, nothing is deleted.
 */
async function saveDeletedTenantEnv(appId: string, tenantId: string, tenantPath: string): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(path.join(tenantPath, '.env'), 'utf-8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return;
    throw new HttpError(500, `Could not save the .env of ${appId}/${tenantId}: it cannot be read (${err?.code || err?.message || err}). Nothing was deleted.`, { expose: true });
  }
  const dir = path.join(getDataDir(), 'deleted-tenants', appId);
  const file = path.join(dir, `${tenantId}-${new Date().toISOString().replace(/[:.]/g, '-')}.env`);
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await writeSecretFile(file, content);
  } catch (err: any) {
    throw new HttpError(500, `Could not save the .env of ${appId}/${tenantId} to ${dir} (${err?.code || err?.message || err}). Nothing was deleted.`, { expose: true });
  }
  console.log(`[deleteTenant] ${appId}/${tenantId}: keeping its database and volumes; saved its .env to ${file}`);
}

export function deleteTenant(appId: string, tenantId: string, keepData: boolean = false): Promise<void> {
  return withTenantLock(appId, tenantId, () => deleteTenantLocked(appId, tenantId, keepData));
}

/** Caller must hold the tenant lock. */
export async function deleteTenantLocked(appId: string, tenantId: string, keepData: boolean): Promise<void> {
  const tenantPath = getTenantPath(appId, tenantId);

  // Check if tenant exists
  try {
    await fs.access(tenantPath);
  } catch {
    throw new NotFoundError(`Tenant '${tenantId}' not found in app '${appId}'`);
  }

  // Verify path hasn't been manipulated via symlinks
  await assertTenantDir(appId, tenantId);

  // The exact database, resolved before anything is stopped: the tenant's own
  // definition (getApp() is null for a trashed app, whose db_prefix may differ
  // from the project's) and its .env DB_NAME. Throws when it cannot be
  // determined, so the delete fails closed instead of orphaning the database.
  const dbName = keepData ? null : await resolveTenantDbName(appId, tenantId, await resolveTenantApp(appId, tenantId));

  const composePath = path.join(tenantPath, 'docker-compose.yml');
  if (keepData) {
    await saveDeletedTenantEnv(appId, tenantId, tenantPath);
  } else {
    await guardUnownedVolumes(composePath, appId, tenantId);
  }

  // Stop containers. If this fails we refuse to drop the DB — orphaned
  // containers running against a gone DB are worse than an incomplete delete.
  // Caller can retry once the compose issue is resolved. Keep data keeps the
  // volumes too, so no `-v`.
  let composeDownOk = true;
  try {
    await execDocker(['compose', '--project-directory', tenantPath, '-f', composePath, 'down', ...(keepData ? [] : ['-v'])]);
  } catch (err: any) {
    composeDownOk = false;
    if (!keepData) {
      throw new HttpError(
        500,
        `Failed to stop tenant containers: ${err?.message || err}. Refusing to drop database — fix and retry.`,
        { expose: true },
      );
    }
    // With keepData=true, containers may already be gone; continue.
    console.warn(`[deleteTenant] compose down failed: ${err?.message || err}. Continuing because keepData=true.`);
  }

  // Drop database unless keeping data. dbName is the full name, so the
  // adapter must not prepend a prefix.
  if (dbName !== null && composeDownOk) {
    const db = getDatabaseAdapter({ db_prefix: '' });
    await db.initialize();
    await db.dropDatabase(dbName);
  }

  // Clean up tenant env var overrides only once teardown has succeeded: a
  // failed compose down throws above and the tenant must keep its config for
  // the retry.
  await deleteTenantAllOverrides(appId, tenantId);

  // Remove tenant directory
  await fs.rm(tenantPath, { recursive: true, force: true });
}

export function updateTenant(
  rawAppId: string,
  rawTenantId: string,
  newTag: string,
  onProgress?: (progress: TenantUpdateProgress) => void,
): Promise<void> {
  return withTenantLock(String(rawAppId), String(rawTenantId), () => updateTenantLocked(rawAppId, rawTenantId, newTag, onProgress));
}

async function updateTenantLocked(
  rawAppId: string,
  rawTenantId: string,
  newTag: string,
  onProgress?: (progress: TenantUpdateProgress) => void,
): Promise<void> {
  // Extract IDs via regex match so subsequent path.join calls operate on the
  // captured strings, not the raw inputs. Route middleware already enforces;
  // this breaks taint flow visibly for static analysis and protects CLI callers.
  const appIdMatch = rawAppId.match(SLUG_RE);
  if (!appIdMatch) {
    throw new ValidationError('Invalid app ID. Must be lowercase alphanumeric with hyphens.');
  }
  const appId = appIdMatch[0];
  const tenantIdMatch = rawTenantId.match(SLUG_RE);
  if (!tenantIdMatch) {
    throw new ValidationError('Invalid tenant ID. Must be lowercase alphanumeric with hyphens.');
  }
  const tenantId = tenantIdMatch[0];
  const tagValidation = validateImageTag(newTag);
  if (!tagValidation.valid) {
    throw new ValidationError(tagValidation.error!);
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
    try { onProgress?.(payload); } catch { /* swallow */ }
  };

  // Check if tenant exists
  try {
    await fs.access(envPath);
  } catch {
    throw new NotFoundError(`Tenant '${tenantId}' not found in app '${appId}'`);
  }

  // Verify path hasn't been manipulated via symlinks
  await assertTenantDir(appId, tenantId);

  // This tenant's effective app definition: its snapshot, with registry,
  // default tag and identity from the global definition (see overlayGlobalApp).
  let app = await resolveTenantApp(appId, tenantId);
  if (!app) {
    throw new NotFoundError(`App '${appId}' not found`);
  }

  // Read current .env
  const originalEnvContent = await fs.readFile(envPath, 'utf-8');
  const originalComposeContent = await fs.readFile(composePath, 'utf-8');

  // Resolve the image refs the tenant is currently running so we can clean
  // them up after a successful update. Done before any mutation so env
  // interpolation resolves against the *running* state. Best-effort: if
  // `compose config` fails we just skip cleanup later.
  const oldImages = await listComposeImages(tenantPath, composePath).catch(() => [] as string[]);

  let originalSharedEnvContent: string | null = null;
  try {
    originalSharedEnvContent = await fs.readFile(sharedEnvPath, 'utf-8');
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }
  const originalTenantAppStatic = toStaticAppDefinition(app);
  const originalGlobalApp = await getApp(appId);
  const originalGlobalAppStatic = originalGlobalApp ? toStaticAppDefinition(originalGlobalApp) : null;
  // What this update wrote to the global definition (as stored), or null.
  let appliedGlobalStatic: AppDefinitionStatic | null = null;

  const restoreAppDefinitions = async () => {
    await writeTenantAppDef(appId, tenantId, originalTenantAppStatic);
    if (appliedGlobalStatic && originalGlobalAppStatic) {
      // Compare-and-restore: another update (or an admin edit) may have changed
      // the definition since this one applied it; rolling back would undo theirs.
      const stored = await getApp(appId);
      if (stored && isDeepStrictEqual(toStaticAppDefinition(stored), appliedGlobalStatic)) {
        await applyApp(originalGlobalAppStatic, `rollback:${appId}/${tenantId}`);
      } else {
        console.warn('[tenant] skipped app-definition rollback: changed concurrently');
      }
    }
  };

  const restoreTenantUpdateState = async () => {
    await writeSecretFile(envPath, originalEnvContent);
    if (originalSharedEnvContent === null) {
      await fs.rm(sharedEnvPath, { force: true });
    } else {
      await writeSecretFile(sharedEnvPath, originalSharedEnvContent);
    }
    await writeFileAtomic(composePath, originalComposeContent);
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
        throw new HttpError(500, `Image manifest failed validation: ${errors}`, { expose: true });
      }
      const globalForManifest = await getApp(appId);
      const normalizedManifest = overlayGlobalApp(parsed.data, globalForManifest);
      // The image may only change allowlisted fields; protected ones keep the
      // admin's value. The snapshot and the global definition get the same result.
      const { next: allowedManifest, ignored } = applyManifestPolicy(
        manifestPolicyBaseline(globalForManifest ? toStaticAppDefinition(globalForManifest) : null, originalTenantAppStatic),
        normalizedManifest,
      );
      const ignoredNote = ignored.length > 0 ? `; ignored protected fields: ${ignored.join(', ')}` : '';
      if (ignored.length > 0) {
        console.warn(`[manifest] ignored protected fields from image ${newTag}: ${ignored.join(', ')} (app '${appId}', tenant '${tenantId}')`);
      }
      await writeTenantAppDef(appId, tenantId, allowedManifest);
      const result = await applyApp(allowedManifest, `manifest:${resolveManifestImageRef(app, newTag)}`);
      appliedGlobalStatic = toStaticAppDefinition(result.app);
      if (result.result === 'updated') {
        console.log(`[manifest] Updated app '${appId}' from image ${newTag} for tenant '${tenantId}' (changed: ${result.changedKeys.join(', ')})`);
        emit('manifest', 'completed', `updated (changed: ${result.changedKeys.join(', ') || 'none'})${ignoredNote}`);
      } else if (result.result === 'created') {
        console.log(`[manifest] Created app '${appId}' from image ${newTag} for tenant '${tenantId}'`);
        emit('manifest', 'completed', `created${ignoredNote}`);
      } else {
        emit('manifest', 'completed', `noop (manifest matches current definition)${ignoredNote}`);
      }
      // Re-apply the overlay: manifest sync can overwrite the registry block
      // with whatever is in the image's embedded /overwatch/app.json, which
      // for older images may carry a stale repo. The global definition is
      // the source of truth for "where do we pull from"; manifest content
      // for that field is ignored.
      const reloaded = await resolveTenantApp(appId, tenantId);
      if (reloaded) app = reloaded;
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
    await generateSharedEnvFile(appId, tenantId, { alreadyLocked: true });

    const domainMatch = originalEnvContent.match(/^TENANT_DOMAIN=(.*)$/m);
    const domain = domainMatch ? domainMatch[1] : '';

    try {
      const tenantTraefik = await readTenantTraefik(appId, tenantId);
      const composeContent = generateComposeFile({ app, tenantId, domain, config, tenantTraefik, existingCompose: originalComposeContent });
      await writeFileAtomic(composePath, composeContent);
    } catch (err) {
      console.warn('Failed to regenerate docker-compose.yml:', err);
      await writeFileAtomic(composePath, originalComposeContent);
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
    await execDocker(['compose', '--project-directory', tenantPath, '-f', composePath, 'pull'], COMPOSE_LONG_TIMEOUT_MS);
    await ensureExternalVolumes(composePath);
    emit('pull', 'completed');
  } catch (error: any) {
    await restoreTenantUpdateStateBestEffort('pull failure');
    const detail = extractComposeErrorMessage(error);
    emit('pull', 'failed', detail);
    emit('failed', 'failed', detail);
    throw new HttpError(500, detail, { expose: true });
  }

  // Restart containers with new images. --remove-orphans sweeps containers
  // that used to be part of this compose stack but aren't in the regenerated
  // file (e.g. a service removed via an upstream manifest update).
  emit('restart', 'started');
  try {
    await execDocker(['compose', '--project-directory', tenantPath, '-f', composePath, 'up', '-d', '--force-recreate', '--remove-orphans'], COMPOSE_LONG_TIMEOUT_MS);
    emit('restart', 'completed');
    await pruneReplacedImages(oldImages, tenantPath, composePath, appId, tenantId);
    emit('done', 'completed');
  } catch (error: any) {
    // Collect init container evidence BEFORE rolling back — the restore below
    // recreates containers and destroys the failed migrator's logs. With
    // dependents gated on service_completed_successfully, a failed migration
    // lands here, and "didn't complete successfully: exit 127" alone doesn't
    // tell an operator what broke.
    const composeError = extractComposeErrorMessage(error);
    const initFailures = await describeFailedInitContainers(app, tenantId).catch(() => '');
    const detail = initFailures ? `${composeError}\n\n${initFailures}` : composeError;
    await restoreTenantUpdateStateBestEffort('restart failure');
    await execDocker(['compose', '--project-directory', tenantPath, '-f', composePath, 'up', '-d', '--force-recreate'], COMPOSE_LONG_TIMEOUT_MS).catch((rollbackErr: any) => {
      console.error(`[tenant:update] Failed to restart restored compose for ${appId}/${tenantId}: ${rollbackErr?.message || rollbackErr}`);
    });
    emit('restart', 'failed', detail);
    emit('failed', 'failed', detail);
    throw new HttpError(500, detail, { expose: true });
  }
}

/**
 * Resolve the fully-rendered image refs in a tenant's compose file, with all
 * env interpolation applied. Uses `docker compose config --images` rather
 * than parsing YAML by hand so future compose features (variable defaults,
 * extends, includes) keep working.
 */
async function listComposeImages(tenantPath: string, composePath: string): Promise<string[]> {
  const { stdout } = await execDocker(
    ['compose', '--project-directory', tenantPath, '-f', composePath, 'config', '--images'],
  );
  return stdout.split('\n').map(line => line.trim()).filter(Boolean);
}

/**
 * After a successful tenant update, drop the previous image tags that the
 * regenerated compose no longer references. `docker rmi` fails harmlessly
 * when another container still references the image, so this is safe across
 * tenants that share a repo on different tags. Best-effort: never throws.
 */
async function pruneReplacedImages(
  oldImages: string[],
  tenantPath: string,
  composePath: string,
  appId: string,
  tenantId: string,
): Promise<void> {
  if (oldImages.length === 0) return;
  try {
    const newImages = new Set(await listComposeImages(tenantPath, composePath));
    for (const img of oldImages) {
      if (newImages.has(img)) continue;
      await execDocker(['rmi', img]).catch((err: any) => {
        const detail = (err?.stderr ?? '').toString().trim() || err?.message || String(err);
        console.log(`[tenant:update] skip rmi ${img} for ${appId}/${tenantId}: ${detail}`);
      });
    }
  } catch (err: any) {
    console.warn(`[tenant:update] image cleanup skipped for ${appId}/${tenantId}: ${err?.message || err}`);
  }
}

/**
 * Generate .env content for a tenant using configuration
 */
function generateEnvContent(
  config: ReturnType<typeof loadConfig>,
  app: AppDefinition,
  identity: TenantIdentity,
  dbName: string,
  domain: string,
  imageTag: string,
  dbPassword: string,
  jwtSecret: string
): string {
  const { tenantId } = identity;
  const imageRegistry = `${app.registry.url}/${app.registry.repository}`;
  const sharedNetwork = config.networking?.external_network || `${config.project.prefix}-network`;

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
COMPOSE_PROJECT_NAME=${identity.composeProject}

# App Identification
APP_ID=${formatEnvValue(app.id)}

# Tenant Identification
TENANT_ID=${formatEnvValue(tenantId)}
TENANT_DOMAIN=${formatEnvValue(domain)}

# Container Image Configuration
IMAGE_REGISTRY=${formatEnvValue(imageRegistry)}
IMAGE_TAG=${formatEnvValue(imageTag)}

# Project Configuration
PROJECT_PREFIX=${formatEnvValue(config.project.prefix)}

# Database Configuration
DB_HOST=${formatEnvValue(config.database.host)}
DB_PORT=${formatEnvValue(config.database.port)}
DB_NAME=${formatEnvValue(dbName)}
DB_USER=${formatEnvValue(dbName)}
DB_PASSWORD=${formatEnvValue(dbPassword)}

# Application Security
JWT_SECRET=${formatEnvValue(jwtSecret)}

# Network Configuration
SHARED_NETWORK=${formatEnvValue(sharedNetwork)}

# TLS Configuration
CERT_RESOLVER=${formatEnvValue(certResolver)}
`;
}
