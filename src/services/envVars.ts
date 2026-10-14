import * as fs from 'fs/promises';
import * as path from 'path';
import { z } from 'zod';
import { getDataDir } from '../config';
import { withFileLock, withTenantLock } from './fileLock';
import { COMPOSE_LONG_TIMEOUT_MS } from './composeTimeouts';
import { writeSecretFile } from '../utils/security';
import { tenantDir, assertTenantDir, listTenantDirs } from './tenantStore';
import { ConflictError, HttpError, NotFoundError, ValidationError } from '../utils/httpErrors';

const EnvVarSchema = z.object({
  key: z.string(),
  value: z.string(),
  sensitive: z.boolean(),
  description: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const TenantOverrideItemSchema = z.object({
  key: z.string(),
  value: z.string(),
  sensitive: z.boolean(),
  updatedAt: z.string(),
});
const TenantOverrideSchema = z.object({
  tenantId: z.string(),
  overrides: z.array(TenantOverrideItemSchema),
});
const EnvVarsStoreSchema = z.record(z.array(EnvVarSchema));
const TenantOverridesStoreSchema = z.record(z.array(TenantOverrideSchema));

function getEnvVarsFile(): string {
  return path.join(getDataDir(), 'env-vars.json');
}

function getTenantOverridesFile(): string {
  return path.join(getDataDir(), 'tenant-env-overrides.json');
}

const PROTECTED_KEYS = new Set([
  'NODE_ENV', 'PORT', 'FRONTEND_URL', 'BACKEND_URL',
  'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME',
  'JWT_SECRET', 'JWT_EXPIRES_IN', 'TENANT_ID', 'TENANT_DOMAIN',
  'IMAGE_REGISTRY', 'IMAGE_TAG', 'PROJECT_PREFIX', 'SHARED_NETWORK',
  'APP_ID', 'CERT_RESOLVER',
  // Node.js / system vars that could alter runtime behavior
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'PATH', 'HOME', 'SHELL',
]);

export function isProtectedEnvVarKey(key: string): boolean {
  return PROTECTED_KEYS.has(key);
}

export interface EnvVar {
  key: string;
  value: string;
  sensitive: boolean;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TenantEnvOverride {
  tenantId: string;
  overrides: Array<{ key: string; value: string; sensitive: boolean; updatedAt: string }>;
}

export interface EffectiveEnvVar {
  key: string;
  value: string;
  sensitive: boolean;
  description?: string;
  source: 'global' | 'override' | 'tenant-only';
}

// ─── Storage format: keyed by appId ─────────────────────────────────────────

// env-vars.json: { "myapp": [...vars], "cms": [...vars] }
type EnvVarsStore = Record<string, EnvVar[]>;

// tenant-env-overrides.json: { "myapp": [{ tenantId, overrides }], ... }
type TenantOverridesStore = Record<string, TenantEnvOverride[]>;

async function ensureDataDir(): Promise<void> {
  try {
    await fs.mkdir(getDataDir(), { recursive: true });
  } catch (error) {
    // Directory might already exist
  }
}

async function readEnvVarsStore(): Promise<EnvVarsStore> {
  let data: string;
  try {
    data = await fs.readFile(getEnvVarsFile(), 'utf-8');
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      await saveEnvVarsStore({});
      return {};
    }
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch (err: any) {
    throw new Error(`env-vars.json is not valid JSON (${err.message}). Refusing to auto-reset.`);
  }
  // Handle legacy format (flat array) — treat as no apps, do NOT overwrite silently.
  if (Array.isArray(raw)) return {};
  const parsed = EnvVarsStoreSchema.safeParse(raw);
  if (!parsed.success) {
    const errors = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new Error(`env-vars.json failed validation: ${errors}`);
  }
  return parsed.data;
}

async function saveEnvVarsStore(store: EnvVarsStore): Promise<void> {
  await ensureDataDir();
  await writeSecretFile(getEnvVarsFile(), JSON.stringify(store, null, 2));
}

async function readTenantOverridesStore(): Promise<TenantOverridesStore> {
  let data: string;
  try {
    data = await fs.readFile(getTenantOverridesFile(), 'utf-8');
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      await saveTenantOverridesStore({});
      return {};
    }
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch (err: any) {
    throw new Error(`tenant-env-overrides.json is not valid JSON (${err.message}). Refusing to auto-reset.`);
  }
  if (Array.isArray(raw)) return {};
  const parsed = TenantOverridesStoreSchema.safeParse(raw);
  if (!parsed.success) {
    const errors = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new Error(`tenant-env-overrides.json failed validation: ${errors}`);
  }
  return parsed.data;
}

async function saveTenantOverridesStore(store: TenantOverridesStore): Promise<void> {
  await ensureDataDir();
  await writeSecretFile(getTenantOverridesFile(), JSON.stringify(store, null, 2));
}

export function validateEnvVarKey(key: string): { valid: boolean; error?: string } {
  if (!key) {
    return { valid: false, error: 'Key is required' };
  }
  // Normalise before the key-format and protected-key checks so whitespace /
  // case tricks can't bypass PROTECTED_KEYS.
  const normalised = key.trim();
  if (!/^[A-Z][A-Z0-9_]*$/.test(normalised)) {
    return { valid: false, error: 'Key must match format: starts with uppercase letter, followed by uppercase letters, digits, or underscores' };
  }
  if (PROTECTED_KEYS.has(normalised)) {
    return { valid: false, error: `Key "${normalised}" is a protected core variable and cannot be used` };
  }
  // Callers persist the raw key and shared.env writes it verbatim, so padding
  // (e.g. "FOO\n") would corrupt the env file and " FOO" would shadow "FOO".
  if (normalised !== key) {
    return { valid: false, error: 'Key must not contain leading or trailing whitespace' };
  }
  return { valid: true };
}

/**
 * Validate an env var value: reject characters that would break the shared.env
 * line format (newlines, CR, NUL). Without this a caller with setEnvVar access
 * can inject additional KEY=VALUE lines and override protected core vars (DB_PASSWORD,
 * JWT_SECRET etc.) that docker-compose loads from the same env_file.
 */
export function validateEnvVarValue(value: string): { valid: boolean; error?: string } {
  if (typeof value !== 'string') {
    return { valid: false, error: 'Value must be a string' };
  }
  if (/[\r\n\0]/.test(value)) {
    return { valid: false, error: 'Value must not contain newlines, carriage returns, or NUL bytes' };
  }
  return { valid: true };
}

/**
 * Render a value for a compose env file (`.env` / `shared.env`). Compose
 * interpolates `$VAR` / `${VAR}` in unquoted and double-quoted values, which
 * would blank or rewrite a password or URL holding `$`. Single quotes are read
 * literally; a value that also holds `'` falls back to double quotes with
 * `\`, `"` and `$` backslash-escaped. Values without `$` or edge whitespace
 * stay unquoted, as before. The same rules apply to the project-level `.env` compose reads.
 */
export function formatEnvValue(value: string | number): string {
  const v = String(value);
  // Compose trims unquoted leading/trailing whitespace, so such values need quotes too.
  if (!v.includes('$') && !/^\s|\s$/.test(v)) return v;
  if (!v.includes("'")) return `'${v}'`;
  return `"${v.replace(/[\\"$]/g, c => `\\${c}`)}"`;
}

export function formatEnvLine(key: string, value: string | number): string {
  return `${key}=${formatEnvValue(value)}`;
}

// ─── Global env vars CRUD (per app) ─────────────────────────────────────────

export async function listEnvVars(appId: string): Promise<EnvVar[]> {
  const store = await readEnvVarsStore();
  return store[appId] || [];
}

export async function setEnvVar(
  appId: string,
  key: string,
  value: string,
  sensitive: boolean = false,
  description?: string
): Promise<EnvVar> {
  const keyValidation = validateEnvVarKey(key);
  if (!keyValidation.valid) {
    throw new ValidationError(keyValidation.error || 'Invalid environment variable key');
  }
  const valueValidation = validateEnvVarValue(value);
  if (!valueValidation.valid) {
    throw new ValidationError(valueValidation.error || 'Invalid environment variable value');
  }

  return withFileLock('env-vars', async () => {
    const store = await readEnvVarsStore();
    if (!store[appId]) store[appId] = [];
    const vars = store[appId];
    const now = new Date().toISOString();
    const existing = vars.find(v => v.key === key);

    if (existing) {
      existing.value = value;
      existing.sensitive = sensitive;
      if (description !== undefined) {
        existing.description = description;
      }
      existing.updatedAt = now;
    } else {
      vars.push({
        key,
        value,
        sensitive,
        description,
        createdAt: now,
        updatedAt: now,
      });
    }

    await saveEnvVarsStore(store);
    return vars.find(v => v.key === key)!;
  });
}

export async function deleteEnvVar(appId: string, key: string): Promise<void> {
  return withFileLock('env-vars', async () => {
    const store = await readEnvVarsStore();
    const vars = store[appId] || [];
    const index = vars.findIndex(v => v.key === key);
    if (index === -1) {
      throw new NotFoundError(`Environment variable "${key}" not found`);
    }
    vars.splice(index, 1);
    store[appId] = vars;
    await saveEnvVarsStore(store);
  });
}

// ─── Per-tenant overrides ────────────────────────────────────────────────────

export async function getTenantOverrides(appId: string, tenantId: string): Promise<TenantEnvOverride['overrides']> {
  const store = await readTenantOverridesStore();
  const appOverrides = store[appId] || [];
  const tenant = appOverrides.find(t => t.tenantId === tenantId);
  return tenant?.overrides || [];
}

export async function setTenantOverride(
  appId: string,
  tenantId: string,
  key: string,
  value: string,
  sensitive?: boolean,
): Promise<void> {
  const keyValidation = validateEnvVarKey(key);
  if (!keyValidation.valid) {
    throw new ValidationError(keyValidation.error || 'Invalid environment variable key');
  }
  const valueValidation = validateEnvVarValue(value);
  if (!valueValidation.valid) {
    throw new ValidationError(valueValidation.error || 'Invalid environment variable value');
  }

  return withFileLock('tenant-overrides', async () => {
    const store = await readTenantOverridesStore();
    if (!store[appId]) store[appId] = [];
    const appOverrides = store[appId];
    let tenant = appOverrides.find(t => t.tenantId === tenantId);

    if (!tenant) {
      tenant = { tenantId, overrides: [] };
      appOverrides.push(tenant);
    }

    const now = new Date().toISOString();
    const existing = tenant.overrides.find(o => o.key === key);
    // An omitted flag keeps the stored one, or inherits the global variable's:
    // defaulting to false would unmask a secret in the tenant's merged view.
    const effectiveSensitive = sensitive
      ?? existing?.sensitive
      ?? (await listEnvVars(appId)).find(v => v.key === key)?.sensitive
      ?? false;

    if (existing) {
      existing.value = value;
      existing.sensitive = effectiveSensitive;
      existing.updatedAt = now;
    } else {
      tenant.overrides.push({ key, value, sensitive: effectiveSensitive, updatedAt: now });
    }

    await saveTenantOverridesStore(store);
  });
}

export async function deleteTenantOverride(appId: string, tenantId: string, key: string): Promise<void> {
  return withFileLock('tenant-overrides', async () => {
    const store = await readTenantOverridesStore();
    const appOverrides = store[appId] || [];
    const tenant = appOverrides.find(t => t.tenantId === tenantId);

    if (!tenant) {
      throw new NotFoundError(`No overrides found for tenant "${tenantId}"`);
    }

    const index = tenant.overrides.findIndex(o => o.key === key);
    if (index === -1) {
      throw new NotFoundError(`Override "${key}" not found for tenant "${tenantId}"`);
    }

    tenant.overrides.splice(index, 1);

    // Remove tenant entry if no overrides remain
    if (tenant.overrides.length === 0) {
      const tenantIndex = appOverrides.indexOf(tenant);
      appOverrides.splice(tenantIndex, 1);
    }

    await saveTenantOverridesStore(store);
  });
}

export async function deleteTenantAllOverrides(appId: string, tenantId: string): Promise<void> {
  return withFileLock('tenant-overrides', async () => {
    const store = await readTenantOverridesStore();
    const appOverrides = store[appId] || [];
    const index = appOverrides.findIndex(t => t.tenantId === tenantId);

    if (index !== -1) {
      appOverrides.splice(index, 1);
      await saveTenantOverridesStore(store);
    }
  });
}

// ─── Merged view ─────────────────────────────────────────────────────────────

export async function getEffectiveEnvVars(appId: string, tenantId: string): Promise<EffectiveEnvVar[]> {
  const globalVars = await listEnvVars(appId);
  const tenantOverrides = await getTenantOverrides(appId, tenantId);

  const effective: EffectiveEnvVar[] = [];

  for (const gv of globalVars) {
    const override = tenantOverrides.find(o => o.key === gv.key);
    if (override) {
      effective.push({
        key: gv.key,
        value: override.value,
        sensitive: override.sensitive,
        description: gv.description,
        source: 'override',
      });
    } else {
      effective.push({
        key: gv.key,
        value: gv.value,
        sensitive: gv.sensitive,
        description: gv.description,
        source: 'global',
      });
    }
  }

  // Add overrides for keys not in global (tenant-only vars)
  for (const ov of tenantOverrides) {
    if (!globalVars.find(gv => gv.key === ov.key)) {
      effective.push({
        key: ov.key,
        value: ov.value,
        sensitive: ov.sensitive,
        source: 'tenant-only',
      });
    }
  }

  return effective;
}

// ─── File generation ─────────────────────────────────────────────────────────

/**
 * Regenerate one tenant's shared.env under the tenant lock, so it cannot
 * interleave with updateTenant's shared.env rollback. Callers that already
 * hold the tenant lock (create/update) pass `alreadyLocked`: the lock is not
 * re-entrant.
 */
export function generateSharedEnvFile(
  appId: string,
  tenantId: string,
  opts: { alreadyLocked?: boolean } = {},
): Promise<void> {
  if (opts.alreadyLocked) return generateSharedEnvFileUnlocked(appId, tenantId);
  return withTenantLock(appId, tenantId, () => generateSharedEnvFileUnlocked(appId, tenantId));
}

/** How long an HTTP-triggered regeneration waits for a tenant that is mid-operation before deferring it. */
const SHARED_ENV_BUSY_WAIT_MS = 2_000;

// Tenants with a deferred regeneration queued for the lock. An entry is removed
// the moment the lock is acquired (before the store is read), so a request made
// after that point schedules a fresh run instead of being swallowed.
const pendingBackground = new Map<string, symbol>();

function scheduleBackgroundSharedEnv(appId: string, tenantId: string): void {
  const id = `${appId}/${tenantId}`;
  if (pendingBackground.has(id)) return;
  const token = Symbol(id);
  pendingBackground.set(id, token);
  withTenantLock(appId, tenantId, async () => {
    pendingBackground.delete(id);
    // Reads the env-var store now, so it can never write a value older than the save that scheduled it.
    await generateSharedEnvFileUnlocked(appId, tenantId);
  }, { waitMs: COMPOSE_LONG_TIMEOUT_MS, unref: true }).then(
    () => console.log(`[env-vars] background shared.env regeneration for ${id} done`),
    (err: any) => {
      // Only clear our own entry: a newer run may have been scheduled after we got the lock.
      if (pendingBackground.get(id) === token) pendingBackground.delete(id);
      console.error(`[env-vars] background shared.env regeneration for ${id} failed: ${err?.message || err}`);
    },
  );
}

/**
 * Regenerate one tenant's shared.env for a request: waits briefly for the tenant
 * lock; a tenant that is mid-operation is not a failure, its regeneration is
 * deferred until the lock frees and the caller is told it was busy.
 */
export async function regenerateTenantSharedEnv(
  appId: string,
  tenantId: string,
  opts: { waitMs?: number } = {},
): Promise<{ busy: boolean }> {
  try {
    await withTenantLock(appId, tenantId, () => generateSharedEnvFileUnlocked(appId, tenantId), { waitMs: opts.waitMs ?? SHARED_ENV_BUSY_WAIT_MS });
    return { busy: false };
  } catch (err) {
    if (!(err instanceof ConflictError)) throw err;
    scheduleBackgroundSharedEnv(appId, tenantId);
    return { busy: true };
  }
}

async function generateSharedEnvFileUnlocked(appId: string, tenantId: string): Promise<void> {
  const tenantPath = tenantDir(appId, tenantId);

  // Check tenant directory exists
  try {
    await fs.access(tenantPath);
  } catch {
    return; // Skip if tenant directory doesn't exist
  }

  // Verify path hasn't been manipulated via symlinks
  await assertTenantDir(appId, tenantId);

  const effective = await getEffectiveEnvVars(appId, tenantId);

  const lines = [
    '# Shared environment variables',
    `# Generated by Overwatch: ${new Date().toISOString()}`,
    '# Do not edit manually - managed via Overwatch admin panel',
    '',
  ];

  for (const v of effective) {
    lines.push(formatEnvLine(v.key, v.value));
  }

  lines.push(''); // trailing newline

  const sharedEnvPath = path.join(tenantPath, 'shared.env');

  // If shared.env is a symlink, remove it first so we write a real file
  try {
    const stat = await fs.lstat(sharedEnvPath);
    if (stat.isSymbolicLink()) {
      await fs.unlink(sharedEnvPath);
    }
  } catch {
    // File doesn't exist yet, that's fine
  }

  await writeSecretFile(sharedEnvPath, lines.join('\n'));
}

/**
 * Reconcile declared env vars from an app's manifest against what's already
 * in env-vars.json for that app. Missing declared keys get inserted with
 * the declared default (or empty) + description + sensitivity so they
 * appear pre-populated in the admin UI for operators to fill in.
 *
 * - Keys already present in env-vars.json are NEVER overwritten.
 * - Keys that collide with PROTECTED_KEYS (FRONTEND_URL, DB_HOST, etc.)
 *   are ignored with a warning — those are resolved by Overwatch itself.
 * - Returns counts so callers can log activity.
 */
export async function reconcileDeclaredEnvVars(
  appId: string,
  declared: Array<{ key: string; description?: string; sensitive?: boolean; default?: string }>,
): Promise<{ added: number; skippedProtected: string[]; alreadyPresent: number }> {
  const existing = await listEnvVars(appId);
  const existingKeys = new Set(existing.map(v => v.key));
  const skippedProtected: string[] = [];
  let added = 0;
  let alreadyPresent = 0;

  for (const dec of declared) {
    if (isProtectedEnvVarKey(dec.key)) {
      skippedProtected.push(dec.key);
      console.warn(
        `[env-vars] App '${appId}' manifest declares protected key '${dec.key}' — ignored. ` +
        `Overwatch auto-resolves this at compose time; remove the declaration from overwatch/app.json.`
      );
      continue;
    }
    if (existingKeys.has(dec.key)) {
      alreadyPresent += 1;
      continue;
    }
    // setEnvVar validates key/value and persists with timestamps.
    await setEnvVar(
      appId,
      dec.key,
      dec.default ?? '',
      dec.sensitive ?? false,
      dec.description,
    );
    added += 1;
  }

  return { added, skippedProtected, alreadyPresent };
}

/**
 * Regenerate shared.env for all tenants, optionally scoped to a single app.
 *
 * When `onlyAppId` is provided, only that app's tenants are regenerated — this
 * is the right choice for env-var mutations on a specific app, since env vars
 * are per-app and a change in app A must not touch app B's tenant files.
 * Without a filter, this is the boot-time sweep that regenerates every
 * tenant's shared.env across every app.
 */
export interface SharedEnvFailure { appId: string; tenantId: string }

/**
 * Some tenants' shared.env could not be regenerated. The client message lists
 * tenant ids only; the underlying errors (paths, errno text) go to the log.
 */
export class SharedEnvRegenerationError extends HttpError {
  constructor(readonly failures: SharedEnvFailure[], readonly regenerated: number) {
    super(500, `shared.env regeneration failed for ${failures.length} tenant(s): ${failures.map(f => `${f.appId}/${f.tenantId}`).join(', ')}`, { expose: true });
    this.name = 'SharedEnvRegenerationError';
  }
}

/**
 * Regenerate shared.env for all tenants, optionally scoped to a single app.
 *
 * When `onlyAppId` is provided, only that app's tenants are regenerated — this
 * is the right choice for env-var mutations on a specific app, since env vars
 * are per-app and a change in app A must not touch app B's tenant files.
 * Without a filter, this is the boot-time sweep that regenerates every
 * tenant's shared.env across every app.
 *
 * Only a missing apps/tenants directory or a directory without `.env` (not a
 * tenant) is skipped. Any other failure is collected and thrown after the loop
 * as a SharedEnvRegenerationError, so a save never reports success while a
 * shared.env stays stale. A tenant whose lock stays busy past `waitMs` is not a
 * failure: it is listed in `opts.busy` and regenerated in the background.
 */
export async function regenerateAllSharedEnvFiles(
  onlyAppId?: string,
  opts: { busy?: string[]; waitMs?: number } = {},
): Promise<number> {
  let count = 0;
  const failures: SharedEnvFailure[] = [];

  const tenants = await listTenantDirs(onlyAppId, {
    onError: (appId, err: any) => {
      console.error(`[env-vars] cannot list tenants of ${appId}: ${err?.message || err}`);
      failures.push({ appId, tenantId: '*' });
    },
  });

  for (const { appId, tenantId, dir } of tenants) {
    try {
      await fs.access(path.join(dir, '.env'));
    } catch (err: any) {
      if (err.code === 'ENOENT') continue; // Not a tenant directory
      console.error(`[env-vars] cannot read .env of ${appId}/${tenantId}: ${err?.message || err}`);
      failures.push({ appId, tenantId });
      continue;
    }
    try {
      const { busy } = await regenerateTenantSharedEnv(appId, tenantId, { waitMs: opts.waitMs });
      if (busy) opts.busy?.push(`${appId}/${tenantId}`);
      else count++;
    } catch (err: any) {
      console.error(`[env-vars] shared.env regeneration failed for ${appId}/${tenantId}: ${err?.message || err}`);
      failures.push({ appId, tenantId });
    }
  }

  if (failures.length > 0) throw new SharedEnvRegenerationError(failures, count);
  return count;
}
