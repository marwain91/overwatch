import * as fs from 'fs/promises';
import * as path from 'path';
import { getDataDir } from '../config';
import { AppDefinition, AppDefinitionSchema, CreateAppInput, UpdateAppInput } from '../models/app';
import { withFileLock } from './fileLock';

function getAppsFile(): string {
  return path.join(getDataDir(), 'apps.json');
}

async function readApps(): Promise<AppDefinition[]> {
  try {
    const data = await fs.readFile(getAppsFile(), 'utf-8');
    const raw = JSON.parse(data);
    if (!Array.isArray(raw)) return [];
    return raw;
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      await saveApps([]);
      return [];
    }
    throw error;
  }
}

async function saveApps(apps: AppDefinition[]): Promise<void> {
  const dir = getDataDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(getAppsFile(), JSON.stringify(apps, null, 2));
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

export async function deleteApp(id: string, force: boolean = false): Promise<void> {
  return withFileLock('apps', async () => {
    const apps = await readApps();
    const index = apps.findIndex(a => a.id === id);

    if (index === -1) {
      throw new Error(`App '${id}' not found`);
    }

    // Check for existing tenants unless force
    if (!force) {
      const { getAppsDir } = await import('../config/loader');
      const appsDir = getAppsDir();
      const tenantDir = path.join(appsDir, id, 'tenants');
      try {
        const entries = await fs.readdir(tenantDir);
        const tenants = entries.filter(e => !e.startsWith('.'));
        if (tenants.length > 0) {
          throw new Error(`App '${id}' has ${tenants.length} tenant(s). Delete all tenants first or use force=true.`);
        }
      } catch (err: any) {
        if (err.code !== 'ENOENT') throw err;
      }
    }

    apps.splice(index, 1);
    await saveApps(apps);
  });
}
