import * as fs from 'fs/promises';
import * as path from 'path';
import { getDataDir } from '../config';
import { bindRepairDataFiles, secretDataFiles } from '../config/dataFiles';
import { writeSecretFile } from '../utils/security';
import { listTenantDirs } from './tenantStore';

/**
 * Chores `src/index.ts` runs once per boot to bring older deployments up to
 * the current on-disk conventions. Each is idempotent and a no-op on a
 * deployment that is already current.
 */

/**
 * Backfill COMPOSE_PROJECT_NAME into tenant .env files that don't have it.
 * This prevents Docker Compose project name collisions when two apps
 * have tenants with the same ID (e.g. both acme and widgets have "daktela").
 */
export async function backfillComposeProjectNames(): Promise<number> {
  let count = 0;

  for (const { appId, tenantId, dir } of await listTenantDirs(undefined, { onError: () => {} })) {
    const envPath = path.join(dir, '.env');
    try {
      let envContent = await fs.readFile(envPath, 'utf-8');
      if (!envContent.includes('COMPOSE_PROJECT_NAME=')) {
        envContent = envContent.replace(
          /^(# App Identification)/m,
          `# Docker Compose Project Name (must be unique across all apps)\nCOMPOSE_PROJECT_NAME=${appId}-${tenantId}\n\n$1`
        );
        // If the header wasn't found, just prepend it
        if (!envContent.includes('COMPOSE_PROJECT_NAME=')) {
          envContent = `COMPOSE_PROJECT_NAME=${appId}-${tenantId}\n${envContent}`;
        }
        await writeSecretFile(envPath, envContent);
        count++;
      }
    } catch {
      // No .env file, skip
    }
  }

  return count;
}

/**
 * One-time cleanup for deployments created before perm-hardening.
 * Walks every known secret file and chmod 0600 if permissions are looser:
 * the registry's secret data files plus each tenant's `.env` and `shared.env`.
 */
export async function tightenSecretFilePermissions(): Promise<number> {
  const dataDir = getDataDir();
  let count = 0;

  const tighten = async (filePath: string): Promise<void> => {
    try {
      const stat = await fs.stat(filePath);
      if ((stat.mode & 0o777) !== 0o600) {
        await fs.chmod(filePath, 0o600);
        count++;
      }
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
    }
  };

  for (const name of secretDataFiles()) {
    // One unreadable data file must not leave the remaining secret files loose.
    try {
      await tighten(path.join(dataDir, name));
    } catch (err: any) {
      console.error(`[startup] Could not tighten permissions on ${path.join(dataDir, name)}: ${err?.message || err}`);
    }
  }

  for (const { dir } of await listTenantDirs(undefined, { onError: () => {} })) {
    // One unreadable tenant file must not leave the other tenants' secrets loose.
    for (const file of ['.env', 'shared.env']) {
      try {
        await tighten(path.join(dir, file));
      } catch (err: any) {
        console.error(`[startup] Could not tighten permissions on ${path.join(dir, file)}: ${err?.message || err}`);
      }
    }
  }

  return count;
}

/**
 * One-time repair for hosts that ran older docker-compose.yml versions where
 * each data file was a separate bind mount. If the file didn't yet exist on
 * the host, Docker created the bind target as an empty directory — which then
 * looks like a directory to the container and breaks every JSON/log read.
 *
 * For each registry data file flagged `bindRepair`, if it exists as an EMPTY
 * directory, remove it so the app recreates it as a file on first write. A
 * non-empty directory is left alone with a loud warning — operator must
 * intervene rather than risk silent data loss.
 */
export async function repairBindMountedDataFiles(dataDirOverride?: string): Promise<{ repaired: number; stranded: string[] }> {
  const dataDir = dataDirOverride ?? getDataDir();
  let repaired = 0;
  const stranded: string[] = [];

  for (const name of bindRepairDataFiles()) {
    const p = path.join(dataDir, name);
    let stat;
    try {
      stat = await fs.stat(p);
    } catch (err: any) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    if (!stat.isDirectory()) continue;
    const entries = await fs.readdir(p);
    if (entries.length === 0) {
      await fs.rmdir(p);
      repaired++;
      console.warn(`[startup] Removed stray empty directory at ${p} (was created by an older docker-compose bind-mount). App will recreate it as a file.`);
    } else {
      stranded.push(p);
    }
  }

  return { repaired, stranded };
}
