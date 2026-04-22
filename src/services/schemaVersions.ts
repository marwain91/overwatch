import * as path from 'path';
import * as fs from 'fs/promises';
import { getDataDir } from '../config';
import { writeJsonAtomic, readJsonStrict } from '../utils/atomicJson';

/**
 * Sidecar tracking the schema version of each JSON store in data/.
 * Kept separate from the stores themselves so we don't have to break their
 * on-disk shape (apps.json stays an array, env-vars.json stays an object keyed
 * by appId, etc). Future migrations bump the number here and transform data.
 */
export interface SchemaVersions {
  apps: number;
  envVars: number;
  tenantOverrides: number;
  adminUsers: number;
}

export const CURRENT_SCHEMA_VERSIONS: SchemaVersions = {
  apps: 3,
  envVars: 2,
  tenantOverrides: 2,
  adminUsers: 1,
};

function versionsFile(): string {
  return path.join(getDataDir(), '.schema-versions.json');
}

export async function readSchemaVersions(): Promise<Partial<SchemaVersions>> {
  try {
    return await readJsonStrict<Partial<SchemaVersions>>(versionsFile());
  } catch (err: any) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

export async function writeSchemaVersions(v: SchemaVersions): Promise<void> {
  await writeJsonAtomic(versionsFile(), v, { mode: 0o644 });
}

export function findPendingMigrations(stored: Partial<SchemaVersions>): Array<{ store: keyof SchemaVersions; from: number; to: number }> {
  const pending: Array<{ store: keyof SchemaVersions; from: number; to: number }> = [];
  for (const key of Object.keys(CURRENT_SCHEMA_VERSIONS) as Array<keyof SchemaVersions>) {
    const current = stored[key];
    const target = CURRENT_SCHEMA_VERSIONS[key];
    if (current === undefined) {
      // First run — no migration needed, we'll write the marker.
      continue;
    }
    if (current > target) {
      throw new Error(
        `${key} schema version ${current} is newer than code version ${target}. ` +
        `This binary is older than the data on disk — upgrade Overwatch first.`
      );
    }
    if (current < target) {
      pending.push({ store: key, from: current, to: target });
    }
  }
  return pending;
}

/**
 * Initialise schema-versions.json on first boot if it doesn't exist yet.
 * Called after readApps() / readAdminUsers() / readEnvVarsStore() succeed —
 * those calls validate the stores so we know the current state is consistent.
 */
export async function ensureSchemaVersionsInitialised(): Promise<void> {
  try {
    await fs.access(versionsFile());
  } catch {
    await writeSchemaVersions(CURRENT_SCHEMA_VERSIONS);
  }
}
