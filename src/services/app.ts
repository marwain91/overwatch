import * as fs from 'fs/promises';
import * as path from 'path';
import { getDataDir } from '../config';
import {
  AppDefinition,
  AppDefinitionStaticSchema,
  AppRuntimeEntry,
  AppRuntimeStore,
  AppRuntimeStoreSchema,
  CreateAppInput,
  UpdateAppInput,
} from '../models/app';
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
    // TODO(Task 5): wrap readApps in withFileLock once the mutators land. Until then
    // two concurrent synthesis writes race, but the write is idempotent + atomic so
    // the outcome is fine (just duplicated work).
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
  throw new Error('rewritten in Task 5');
}

export async function updateApp(input: UpdateAppInput): Promise<AppDefinition> {
  throw new Error('rewritten in Task 5');
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
  throw new Error('rewritten in Task 5');
}

/** List soft-deleted apps still in the trash (recoverable). */
export async function listTrashedApps(): Promise<TrashedApp[]> {
  return readTrashed();
}

/** Restore a soft-deleted app. Fails if an app with the same id now exists. */
export async function restoreApp(id: string): Promise<AppDefinition> {
  throw new Error('rewritten in Task 5');
}

/**
 * Permanently remove a soft-deleted app from the trash. Does NOT clean up any
 * tenant containers or databases — caller must stop and delete tenants first
 * through the normal tenant lifecycle.
 */
export async function purgeApp(id: string): Promise<void> {
  throw new Error('rewritten in Task 5');
}
