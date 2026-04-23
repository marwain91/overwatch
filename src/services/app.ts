import * as fs from 'fs/promises';
import * as path from 'path';
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
import { writeJsonAtomic, readJsonStrict } from '../utils/atomicJson';

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

async function writeRuntimeStore(store: AppRuntimeStore): Promise<void> {
  await writeJsonAtomic(getRuntimeFile(), store, { mode: 0o644 });
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

async function readApps(): Promise<AppDefinition[]> {
  const files = await listStaticFiles();
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
  return apps;
}

async function writeStatic(appDef: AppDefinition): Promise<void> {
  const { createdAt, updatedAt, ...staticOnly } = appDef;
  await writeJsonAtomic(getStaticFile(appDef.id), staticOnly, { mode: 0o644 });
}

async function removeStatic(id: string): Promise<void> {
  try {
    await fs.unlink(getStaticFile(id));
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }
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
      throw new Error(`App '${input.id}' already exists`);
    }

    const now = new Date().toISOString();
    const app: AppDefinition = { ...input, createdAt: now, updatedAt: now };
    const parsed = AppDefinitionSchema.safeParse(app);
    if (!parsed.success) {
      const errors = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
      throw new Error(`Invalid app definition: ${errors}`);
    }

    await writeStatic(parsed.data);
    await upsertRuntime(parsed.data.id, () => ({ createdAt: now, updatedAt: now }));
    return parsed.data;
  });
}

export async function updateApp(input: UpdateAppInput): Promise<AppDefinition> {
  return withFileLock('apps', async () => {
    const apps = await readApps();
    const index = apps.findIndex(a => a.id === input.id);
    if (index === -1) {
      throw new Error(`App '${input.id}' not found`);
    }

    const now = new Date().toISOString();
    const updated: AppDefinition = { ...apps[index], ...input, updatedAt: now };
    const parsed = AppDefinitionSchema.safeParse(updated);
    if (!parsed.success) {
      const errors = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
      throw new Error(`Invalid app definition: ${errors}`);
    }

    await writeStatic(parsed.data);
    await upsertRuntime(parsed.data.id, prev => ({
      createdAt: prev?.createdAt ?? parsed.data.createdAt,
      updatedAt: now,
    }));
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
): Promise<{ result: ApplyResult; app: AppDefinition; changedKeys: string[] }> {
  return withFileLock('apps', async () => {
    const parsed = AppDefinitionStaticSchema.safeParse(input);
    if (!parsed.success) {
      const errors = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
      throw new Error(`App definition failed validation: ${errors}`);
    }
    const next = parsed.data;

    const trashed = await readTrashed();
    if (trashed.some(t => t.app.id === next.id)) {
      throw new Error(
        `App '${next.id}' is in trash. Restore with 'overwatch apps restore ${next.id}' ` +
        `or permanently remove with 'overwatch apps purge ${next.id}' before applying.`,
      );
    }

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
      const entry = await upsertRuntime(next.id, prevEntry => ({
        createdAt: prevEntry?.createdAt ?? now,
        updatedAt: now,
      }));
      await reconcileEnvVarDeclarations(next);
      return {
        result: 'updated' as ApplyResult,
        app: { ...next, createdAt: entry.createdAt, updatedAt: entry.updatedAt },
        changedKeys,
      };
    }

    const now = new Date().toISOString();
    await writeJsonAtomic(currentFile, next, { mode: 0o644 });
    const entry = await upsertRuntime(next.id, () => ({ createdAt: now, updatedAt: now }));
    await reconcileEnvVarDeclarations(next);
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
      throw new Error(`App '${id}' not found`);
    }

    const { getAppsDir } = await import('../config/loader');
    const tenantDir = path.join(getAppsDir(), id, 'tenants');
    let tenantCount = 0;
    try {
      const entries = await fs.readdir(tenantDir);
      tenantCount = entries.filter(e => !e.startsWith('.')).length;
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }

    if (tenantCount > 0 && !force) {
      throw new Error(`App '${id}' has ${tenantCount} tenant(s). Delete all tenants first or use force=true.`);
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
      throw new Error(`No trashed app with id '${id}' to restore`);
    }
    const apps = await readApps();
    if (apps.some(a => a.id === id)) {
      throw new Error(`Cannot restore '${id}': an app with that id already exists`);
    }
    const restored = trashed[tIdx].app;
    await writeStatic(restored);
    await upsertRuntime(restored.id, () => ({ createdAt: restored.createdAt, updatedAt: restored.updatedAt }));
    trashed.splice(tIdx, 1);
    await saveTrashed(trashed);
    return restored;
  });
}

/**
 * Permanently remove a soft-deleted app from the trash. Does NOT clean up any
 * tenant containers or databases — caller must stop and delete tenants first
 * through the normal tenant lifecycle.
 */
export async function purgeApp(id: string): Promise<void> {
  return withFileLock('apps', async () => {
    const trashed = await readTrashed();
    const tIdx = trashed.findIndex(t => t.app.id === id);
    if (tIdx === -1) {
      throw new Error(`No trashed app with id '${id}' to purge`);
    }
    trashed.splice(tIdx, 1);
    await saveTrashed(trashed);
  });
}
