import * as fs from 'fs/promises';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';
import { getDataDir } from '../config';
import {
  AppDefinition,
  AppDefinitionSchema,
  AppDefinitionStaticSchema,
  AppRuntimeEntry,
  AppRuntimeStore,
  AppRuntimeStoreSchema,
  CreateAppInput,
  UpdateAppInput,
  ApplyResult,
} from '../models/app';
import { withFileLock } from './fileLock';
import { clearAdapterCache } from '../adapters/registry';
import { writeJsonAtomic, readJsonStrict } from '../utils/atomicJson';
import { isReservedSecretEnv, loadConfigOrNull } from '../utils/reservedEnv';
import { ConflictError, NotFoundError, ValidationError } from '../utils/httpErrors';
import { assertServiceNamesValid, assertHealthcheckDurationsValid, assertVolumeNamesValid } from '../utils/validators';
import { assertAppRawLabelsOwned } from './traefikLabels';
import { assertNoMaskedCredentials } from './traefikRedaction';

const APPS_D_DIR = 'apps.d';
const RUNTIME_FILE = 'apps.runtime.json';
const TRASH_FILE = 'apps.trashed.json';

function getAppsDDir(): string {
  return path.join(getDataDir(), APPS_D_DIR);
}

function getStaticFile(id: string): string {
  return path.join(getAppsDDir(), `${id}.json`);
}

function getRuntimeFile(): string {
  return path.join(getDataDir(), RUNTIME_FILE);
}

function getTrashedAppsFile(): string {
  return path.join(getDataDir(), TRASH_FILE);
}

interface TrashedApp {
  app: AppDefinition;
  deletedAt: string;
  deletedBy: string;
  tenantCount: number;
}

async function readRuntimeStore(): Promise<AppRuntimeStore> {
  try {
    const raw = await readJsonStrict<unknown>(getRuntimeFile());
    const parsed = AppRuntimeStoreSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`apps.runtime.json failed validation: ${parsed.error.message}`);
    }
    return parsed.data;
  } catch (err: any) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

// The cache is invalidated after each write, in a finally: a reader that
// started while the write was in flight may have cached the old contents, and
// invalidating first would let exactly that entry survive.
async function writeRuntimeStore(store: AppRuntimeStore): Promise<void> {
  try {
    await writeJsonAtomic(getRuntimeFile(), store, { mode: 0o644 });
  } finally {
    invalidateAppsCache();
  }
}

async function listStaticFiles(): Promise<string[]> {
  try {
    const entries = await fs.readdir(getAppsDDir());
    return entries.filter(e => e.endsWith('.json')).sort();
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      await fs.mkdir(getAppsDDir(), { recursive: true });
      return [];
    }
    throw err;
  }
}

const warnedReserved = new Set<string>();

// Load-time only: stored definitions that loaded before this check must keep loading.
function warnReservedSecretEnv(def: { id: string; admin_access?: { secret_env?: string } }): void {
  const env = def.admin_access?.secret_env;
  if (!env) return;
  const key = `${def.id}:${env}`;
  if (isReservedSecretEnv(env, loadConfigOrNull()) && !warnedReserved.has(key)) {
    warnedReserved.add(key);
    console.warn(`[apps] App '${def.id}' sets admin_access.secret_env to reserved Overwatch secret '${env}'; token minting is refused until it is changed`);
  }
}

// readApps runs on every request and on the monitoring timers. The CLI edits
// apps.d from another process, so the cache is validated against file metadata
// on every call (one readdir + one stat per file) rather than trusted.
// In-process writes also invalidate it: an atomic rename can reuse an inode and
// leave size and mtime unchanged.
let appsCache: { signature: string; apps: AppDefinition[] } | null = null;
let appsCacheGeneration = 0;

function invalidateAppsCache(): void {
  appsCache = null;
  appsCacheGeneration++;
}

async function statSignature(file: string): Promise<string> {
  try {
    const st = await fs.stat(file);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch (err: any) {
    if (err.code === 'ENOENT') return 'absent';
    throw err;
  }
}

/** Fingerprint of everything readApps depends on; null when it cannot be taken. */
async function appsSignature(files: string[]): Promise<string | null> {
  try {
    const parts = await Promise.all([
      statSignature(getRuntimeFile()),
      ...files.map(async f => `${f}:${await statSignature(path.join(getAppsDDir(), f))}`),
    ]);
    return parts.join('|');
  } catch {
    return null;
  }
}

async function readApps(): Promise<AppDefinition[]> {
  const files = await listStaticFiles();
  const generation = appsCacheGeneration;
  // Taken before reading, so a change racing the read invalidates the entry next time.
  const signature = await appsSignature(files);
  if (signature && appsCache?.signature === signature) return structuredClone(appsCache.apps);

  const { apps, runtimeWritten } = await loadApps(files);
  if (signature && !runtimeWritten && generation === appsCacheGeneration) {
    appsCache = { signature, apps: structuredClone(apps) };
  }
  return apps;
}

async function loadApps(files: string[]): Promise<{ apps: AppDefinition[]; runtimeWritten: boolean }> {
  const runtime = await readRuntimeStore();
  let runtimeDirty = false;
  const apps: AppDefinition[] = [];

  for (const filename of files) {
    const fullPath = path.join(getAppsDDir(), filename);
    let data: string;
    try {
      data = await fs.readFile(fullPath, 'utf-8');
    } catch (err: any) {
      throw new Error(`failed to read ${filename}: ${err?.message || err}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch (err: any) {
      throw new Error(`${filename} is not valid JSON (${err.message})`);
    }
    const parsed = AppDefinitionStaticSchema.safeParse(raw);
    if (!parsed.success) {
      const errors = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
      throw new Error(`${filename} failed validation: ${errors}`);
    }
    const staticDef = parsed.data;
    warnReservedSecretEnv(staticDef);

    // File-name sanity: filename id must match the in-file id. Prevents renames
    // from silently producing two copies or mis-keyed runtime entries.
    const filenameId = filename.replace(/\.json$/, '');
    if (filenameId !== staticDef.id) {
      throw new Error(`${filename}: filename id '${filenameId}' does not match in-file id '${staticDef.id}'`);
    }

    let entry = runtime[staticDef.id];
    if (!entry) {
      const stat = await fs.stat(fullPath);
      const when = stat.mtime.toISOString();
      entry = { createdAt: when, updatedAt: when };
      runtime[staticDef.id] = entry;
      runtimeDirty = true;
    }
    apps.push({ ...staticDef, createdAt: entry.createdAt, updatedAt: entry.updatedAt });
  }

  if (runtimeDirty) {
    // Runtime synthesis is called outside withFileLock because readApps is invoked
    // from many routes including GETs that should not block on the apps lock. The
    // concurrent-synthesis race is tolerated: writes are atomic and idempotent.
    await writeRuntimeStore(runtime);
  }
  return { apps, runtimeWritten: runtimeDirty };
}

let appsChangedHook: (() => void | Promise<unknown>) | undefined;
/** Register a callback run after every successful app mutation (used by the backup scheduler). */
export function setAppsChangedHook(fn: (() => void | Promise<unknown>) | undefined): void {
  appsChangedHook = fn;
}
function notifyAppsChanged(): void {
  try {
    Promise.resolve(appsChangedHook?.()).catch(err =>
      console.error('[apps] change hook failed:', err?.message ?? err));
  } catch (err: any) {
    console.error('[apps] change hook failed:', err?.message ?? err);
  }
}

async function writeStatic(appDef: AppDefinition): Promise<void> {
  const { createdAt, updatedAt, ...staticOnly } = appDef;
  try {
    await writeJsonAtomic(getStaticFile(appDef.id), staticOnly, { mode: 0o644 });
  } finally {
    invalidateAppsCache();
  }
}

async function removeStatic(id: string): Promise<void> {
  try {
    await fs.unlink(getStaticFile(id));
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  } finally {
    invalidateAppsCache();
  }
  // Drop any cached registry adapter for this app — registry config is gone.
  clearAdapterCache(id);
}

async function upsertRuntime(id: string, mutator: (prev: AppRuntimeEntry | undefined) => AppRuntimeEntry): Promise<AppRuntimeEntry> {
  const store = await readRuntimeStore();
  const next = mutator(store[id]);
  store[id] = next;
  await writeRuntimeStore(store);
  return next;
}

async function deleteRuntime(id: string): Promise<void> {
  const store = await readRuntimeStore();
  if (store[id]) {
    delete store[id];
    await writeRuntimeStore(store);
  }
}

async function readTrashed(): Promise<TrashedApp[]> {
  try {
    const raw = await readJsonStrict<unknown>(getTrashedAppsFile());
    if (!Array.isArray(raw)) return [];
    return raw as TrashedApp[];
  } catch (err: any) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function saveTrashed(entries: TrashedApp[]): Promise<void> {
  await writeJsonAtomic(getTrashedAppsFile(), entries, { mode: 0o644 });
}

/**
 * Write-path checks every caller gets: the REST routes, `apps apply`, image
 * manifests and Traefik edits. Only what differs from the stored definition is
 * checked, so a definition that loaded before a check existed can still be
 * saved again (a Traefik-only edit, a manifest that leaves a legacy service
 * name alone); new and changed values must pass.
 */
function assertWritable(next: { id: string; services?: unknown[]; traefik?: unknown }, stored: AppDefinition | undefined): void {
  const services = (Array.isArray(next.services) ? next.services : []) as Array<Record<string, any>>;
  const before = new Map((stored?.services ?? []).map(s => [s.name, s as Record<string, any>]));
  const changed = (pick: (svc: Record<string, any> | undefined) => unknown) =>
    services.filter(svc => !isDeepStrictEqual(pick(svc), pick(before.get(svc?.name))));

  assertServiceNamesValid(services.filter(svc => !before.has(svc?.name)));
  assertHealthcheckDurationsValid(changed(svc => svc?.health_check));
  assertVolumeNamesValid(changed(svc => svc?.volumes));
  const rawLabelsChanged = changed(svc => svc?.routing?.raw_labels);
  assertAppRawLabelsOwned(next.id, rawLabelsChanged);
  // A file copied from a non-admin API read carries placeholders, not credentials.
  assertNoMaskedCredentials({
    traefik: isDeepStrictEqual(next.traefik, stored?.traefik) ? undefined : next.traefik as AppDefinition['traefik'],
    services: rawLabelsChanged,
  });
}

async function assertNotTrashed(id: string): Promise<void> {
  const trashed = await readTrashed();
  if (trashed.some(t => t.app.id === id)) {
    throw new ConflictError(
      `App '${id}' is in trash. Restore with 'overwatch apps restore ${id}' ` +
      `or permanently remove with 'overwatch apps purge ${id}' before applying.`,
    );
  }
}

/** Tenant directories under apps/<id>/tenants (dot-entries ignored). */
async function countTenantDirs(id: string): Promise<number> {
  const { getAppsDir } = await import('../config/loader');
  try {
    const entries = await fs.readdir(path.join(getAppsDir(), id, 'tenants'));
    return entries.filter(e => !e.startsWith('.')).length;
  } catch (err: any) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
}

export async function listApps(): Promise<AppDefinition[]> {
  return readApps();
}

export async function getApp(id: string): Promise<AppDefinition | null> {
  const apps = await readApps();
  return apps.find(a => a.id === id) || null;
}

export async function createApp(input: CreateAppInput): Promise<AppDefinition> {
  return withFileLock('apps', async () => {
    const existing = await readApps();
    if (existing.find(a => a.id === input.id)) {
      throw new ConflictError(`App '${input.id}' already exists`);
    }
    // A new app with a trashed id would silently adopt the trashed app's tenants.
    await assertNotTrashed(input.id);

    const now = new Date().toISOString();
    const app: AppDefinition = { ...input, createdAt: now, updatedAt: now };
    const parsed = AppDefinitionSchema.safeParse(app);
    if (!parsed.success) {
      const errors = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
      throw new ValidationError(`Invalid app definition: ${errors}`);
    }
    assertWritable(parsed.data, undefined);

    await writeStatic(parsed.data);
    await upsertRuntime(parsed.data.id, () => ({ createdAt: now, updatedAt: now }));
    await reconcileEnvVarDeclarations(parsed.data);
    notifyAppsChanged();
    return parsed.data;
  });
}

export async function updateApp(input: UpdateAppInput): Promise<AppDefinition> {
  return withFileLock('apps', async () => {
    const apps = await readApps();
    const index = apps.findIndex(a => a.id === input.id);
    if (index === -1) {
      throw new NotFoundError(`App '${input.id}' not found`);
    }

    await assertNotTrashed(input.id);

    const now = new Date().toISOString();
    const updated: AppDefinition = { ...apps[index], ...input, updatedAt: now };
    const parsed = AppDefinitionSchema.safeParse(updated);
    if (!parsed.success) {
      const errors = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
      throw new ValidationError(`Invalid app definition: ${errors}`);
    }
    assertWritable(parsed.data, apps[index]);

    await writeStatic(parsed.data);
    clearAdapterCache(parsed.data.id);
    await upsertRuntime(parsed.data.id, prev => ({
      createdAt: prev?.createdAt ?? parsed.data.createdAt,
      updatedAt: now,
    }));
    await reconcileEnvVarDeclarations(parsed.data);
    notifyAppsChanged();
    return parsed.data;
  });
}

/**
 * Declarative upsert used by `overwatch apps apply <file>`.
 * - Validates against AppDefinitionStaticSchema (rejects forged createdAt/updatedAt).
 * - Errors if the id is currently soft-deleted in the trash.
 * - No-op (does not bump updatedAt) when the on-disk static file is deep-equal.
 */
export async function applyApp(
  input: unknown,
  _actor: string,
  opts: { restore?: (candidate: unknown, stored: AppDefinition | undefined) => unknown } = {},
): Promise<{ result: ApplyResult; app: AppDefinition; changedKeys: string[] }> {
  return withFileLock('apps', async () => {
    // Read-modify-write callers (restoring masked credentials) see the stored app under this lock.
    const stored = (await readApps()).find(a => a.id === (input as { id?: string })?.id);
    const candidate = opts.restore ? opts.restore(input, stored) : input;
    const parsed = AppDefinitionStaticSchema.safeParse(candidate);
    if (!parsed.success) {
      const errors = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
      throw new ValidationError(`App definition failed validation: ${errors}`);
    }
    const next = parsed.data;

    await assertNotTrashed(next.id);
    assertWritable(next, stored?.id === next.id ? stored : undefined);

    const currentFile = getStaticFile(next.id);
    let prevRaw: string | null = null;
    try {
      prevRaw = await fs.readFile(currentFile, 'utf-8');
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }

    if (prevRaw) {
      let prev: typeof next;
      try {
        prev = AppDefinitionStaticSchema.parse(JSON.parse(prevRaw));
      } catch (err: any) {
        throw new Error(
          `apps.d/${next.id}.json exists but failed to parse during apply — ` +
          `inspect and repair the file before re-running: ${err?.message || err}`
        );
      }
      const changedKeys = diffKeys(prev, next);
      if (changedKeys.length === 0) {
        const runtime = await readRuntimeStore();
        const entry = runtime[next.id];
        if (!entry) {
          throw new Error(`apps.d/${next.id}.json exists but apps.runtime.json has no entry — state inconsistent`);
        }
        return {
          result: 'noop' as ApplyResult,
          app: { ...prev, createdAt: entry.createdAt, updatedAt: entry.updatedAt },
          changedKeys: [],
        };
      }
      const now = new Date().toISOString();
      await writeJsonAtomic(currentFile, next, { mode: 0o644 });
      // Invalidate cached registry adapter so registry-config changes take
      // effect on the next pull/login without a container restart. Without
      // this, edits to auth.type / repository / env vars use the stale
      // adapter built at process start.
      clearAdapterCache(next.id);
      const entry = await upsertRuntime(next.id, prevEntry => ({
        createdAt: prevEntry?.createdAt ?? now,
        updatedAt: now,
      }));
      await reconcileEnvVarDeclarations(next);
      notifyAppsChanged();
      return {
        result: 'updated' as ApplyResult,
        app: { ...next, createdAt: entry.createdAt, updatedAt: entry.updatedAt },
        changedKeys,
      };
    }

    const now = new Date().toISOString();
    await writeJsonAtomic(currentFile, next, { mode: 0o644 });
    clearAdapterCache(next.id);
    const entry = await upsertRuntime(next.id, () => ({ createdAt: now, updatedAt: now }));
    await reconcileEnvVarDeclarations(next);
    notifyAppsChanged();
    return {
      result: 'created' as ApplyResult,
      app: { ...next, createdAt: entry.createdAt, updatedAt: entry.updatedAt },
      changedKeys: Object.keys(next),
    };
  });
}

/**
 * Shallow per-key diff using JSON.stringify comparison. Safe for our use
 * because both inputs pass through AppDefinitionStaticSchema.parse, which
 * produces deterministic key ordering derived from the Zod schema — so the
 * same logical object stringifies identically regardless of source.
 */
/**
 * Reconcile the manifest's declared env_vars against the app's env-vars.json.
 * Missing non-protected keys get pre-populated (empty value by default, or
 * declared default) with description + sensitive flag so they appear in the
 * admin UI ready to be filled in. Never overwrites existing values.
 * Dynamic import to avoid the envVars module pulling app.ts on module-load.
 */
async function reconcileEnvVarDeclarations(def: { id: string; env_vars?: Array<{ key: string; description?: string; sensitive?: boolean; default?: string }> }): Promise<void> {
  if (!def.env_vars || def.env_vars.length === 0) return;
  try {
    const { reconcileDeclaredEnvVars } = await import('./envVars');
    const result = await reconcileDeclaredEnvVars(def.id, def.env_vars);
    const bits: string[] = [];
    if (result.added > 0) bits.push(`${result.added} added`);
    if (result.alreadyPresent > 0) bits.push(`${result.alreadyPresent} kept`);
    if (result.skippedProtected.length > 0) bits.push(`${result.skippedProtected.length} skipped (protected: ${result.skippedProtected.join(', ')})`);
    if (bits.length > 0) {
      console.log(`[env-vars] Reconciled declarations for '${def.id}': ${bits.join(', ')}.`);
    }
  } catch (err: any) {
    // Non-fatal — the applyApp itself succeeded, env-vars reconciliation
    // is a nicety. Surface the error so operators notice.
    console.warn(`[env-vars] Reconciliation failed for '${def.id}': ${err?.message || err}`);
  }
}

function diffKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) changed.push(k);
  }
  return changed.sort();
}

/**
 * Delete an app.
 *
 * - force=false (default): refuses if the app has active tenants.
 * - force=true: soft-deletes — moves the entry to apps.trashed.json instead of
 *   discarding. Tenant directories and containers are NOT touched; the app can
 *   be restored with restoreApp() or permanently removed with purgeApp(). This
 *   change was motivated by a prod incident where two apps disappeared after
 *   clicking force-delete, leaving containers orphaned and no recovery path.
 */
export async function deleteApp(id: string, force: boolean = false, deletedBy: string = 'unknown'): Promise<void> {
  return withFileLock('apps', async () => {
    const apps = await readApps();
    const victim = apps.find(a => a.id === id);
    if (!victim) {
      throw new NotFoundError(`App '${id}' not found`);
    }

    const tenantCount = await countTenantDirs(id);

    if (tenantCount > 0 && !force) {
      throw new ConflictError(`App '${id}' has ${tenantCount} tenant(s). Delete all tenants first or use force=true.`);
    }

    // Soft-delete (to apps.trashed.json) only when tenants exist — preserves
    // recovery path for running workloads. When no tenants exist, hard-delete
    // is safe: there's nothing to orphan.
    if (tenantCount > 0) {
      const trashed = await readTrashed();
      trashed.push({ app: victim, deletedAt: new Date().toISOString(), deletedBy, tenantCount });
      await saveTrashed(trashed);
    }

    await removeStatic(id);
    await deleteRuntime(id);
    notifyAppsChanged();
  });
}

/** List soft-deleted apps still in the trash (recoverable). */
export async function listTrashedApps(): Promise<TrashedApp[]> {
  return readTrashed();
}

/** Restore a soft-deleted app. Fails if an app with the same id now exists. */
export async function restoreApp(id: string): Promise<AppDefinition> {
  return withFileLock('apps', async () => {
    const trashed = await readTrashed();
    const tIdx = trashed.findIndex(t => t.app.id === id);
    if (tIdx === -1) {
      throw new NotFoundError(`No trashed app with id '${id}' to restore`);
    }
    const apps = await readApps();
    if (apps.some(a => a.id === id)) {
      throw new ConflictError(`Cannot restore '${id}': an app with that id already exists`);
    }
    const restored = trashed[tIdx].app;
    await writeStatic(restored);
    await upsertRuntime(restored.id, () => ({ createdAt: restored.createdAt, updatedAt: restored.updatedAt }));
    trashed.splice(tIdx, 1);
    await saveTrashed(trashed);
    notifyAppsChanged();
    return restored;
  });
}

/**
 * Permanently remove a soft-deleted app from the trash. Does NOT clean up any
 * tenant containers or databases — caller must stop and delete tenants first
 * through the normal tenant lifecycle. Refused while tenant directories
 * remain: with the trash entry gone they would keep running but be invisible
 * (unless a live app with the same id already lists them).
 */
export async function purgeApp(id: string): Promise<void> {
  return withFileLock('apps', async () => {
    const trashed = await readTrashed();
    const tIdx = trashed.findIndex(t => t.app.id === id);
    if (tIdx === -1) {
      throw new NotFoundError(`No trashed app with id '${id}' to purge`);
    }
    const tenantCount = await countTenantDirs(id);
    if (tenantCount > 0 && !(await readApps()).some(a => a.id === id)) {
      throw new ConflictError(
        `Cannot purge '${id}': ${tenantCount} tenant(s) still exist under apps/${id}/tenants and would become invisible. ` +
        `Restore the app with 'overwatch apps restore ${id}', delete its tenants, then delete the app.`,
      );
    }
    trashed.splice(tIdx, 1);
    await saveTrashed(trashed);
    notifyAppsChanged();
  });
}
