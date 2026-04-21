import * as fs from 'fs/promises';
import * as path from 'path';
import { getDataDir } from '../config';
import { AppDefinition, AppDefinitionSchema, CreateAppInput, UpdateAppInput } from '../models/app';
import { withFileLock } from './fileLock';
import { writeJsonAtomic, readJsonStrict } from '../utils/atomicJson';

function getTrashedAppsFile(): string {
  return path.join(getDataDir(), 'apps.trashed.json');
}

interface TrashedApp {
  app: AppDefinition;
  deletedAt: string;
  deletedBy: string;
  tenantCount: number;
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

function getAppsFile(): string {
  return path.join(getDataDir(), 'apps.json');
}

async function readApps(): Promise<AppDefinition[]> {
  let data: string;
  try {
    data = await fs.readFile(getAppsFile(), 'utf-8');
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      await saveApps([]);
      return [];
    }
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch (err: any) {
    throw new Error(
      `apps.json is not valid JSON (${err.message}). Refusing to auto-reset — inspect and restore from backup.`
    );
  }
  if (!Array.isArray(raw)) {
    throw new Error(`apps.json must be an array; got ${typeof raw}. Refusing to auto-reset.`);
  }
  // Validate every entry; fail loudly on structural drift rather than silently degrading.
  const apps: AppDefinition[] = [];
  for (let i = 0; i < raw.length; i++) {
    const parsed = AppDefinitionSchema.safeParse(raw[i]);
    if (!parsed.success) {
      const errors = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
      throw new Error(`apps.json[${i}] failed validation: ${errors}`);
    }
    apps.push(parsed.data);
  }
  return apps;
}

async function saveApps(apps: AppDefinition[]): Promise<void> {
  await writeJsonAtomic(getAppsFile(), apps, { mode: 0o644 });
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
    const apps = await readApps();

    if (apps.find(a => a.id === input.id)) {
      throw new Error(`App '${input.id}' already exists`);
    }

    const now = new Date().toISOString();
    const app: AppDefinition = {
      ...input,
      createdAt: now,
      updatedAt: now,
    };

    // Validate with Zod
    const parsed = AppDefinitionSchema.safeParse(app);
    if (!parsed.success) {
      const errors = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
      throw new Error(`Invalid app definition: ${errors}`);
    }

    apps.push(parsed.data);
    await saveApps(apps);
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

    const updated: AppDefinition = {
      ...apps[index],
      ...input,
      updatedAt: new Date().toISOString(),
    };

    // Validate with Zod
    const parsed = AppDefinitionSchema.safeParse(updated);
    if (!parsed.success) {
      const errors = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
      throw new Error(`Invalid app definition: ${errors}`);
    }

    apps[index] = parsed.data;
    await saveApps(apps);
    return parsed.data;
  });
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
    const index = apps.findIndex(a => a.id === id);

    if (index === -1) {
      throw new Error(`App '${id}' not found`);
    }

    const { getAppsDir } = await import('../config/loader');
    const appsDir = getAppsDir();
    const tenantDir = path.join(appsDir, id, 'tenants');
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

    const victim = apps[index];

    if (tenantCount > 0) {
      // Soft-delete: move to trash, keep tenant dirs + DBs alive for recovery.
      const trashed = await readTrashed();
      trashed.push({ app: victim, deletedAt: new Date().toISOString(), deletedBy, tenantCount });
      await saveTrashed(trashed);
    }

    apps.splice(index, 1);
    await saveApps(apps);
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
    apps.push(restored);
    await saveApps(apps);
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
