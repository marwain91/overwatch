import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { loadConfig } from '../config';
import { getDatabaseAdapter } from '../adapters/database';
import { getTenantInfo, listTenants } from './docker';
import { getApp } from './app';
import { readTenantAppDef } from './tenantAppDef';
import { AppDefinition } from '../models/app';
import { assertWithinDir } from '../utils/security';
import { tenantDir } from './tenantStore';
import { writeJsonAtomic } from '../utils/atomicJson';
import { invalidateBackupCache } from './backupCache';
import { resolveTenantDbId } from './tenantDb';
import { HttpError, NotFoundError, ValidationError } from '../utils/httpErrors';
import { withTenantLock } from './fileLock';

const rawExecFile = promisify(execFile);
// Every restic/docker shell-out gets a timeout and a bounded buffer. Without
// maxBuffer, large `restic snapshots` output used to overflow Node's 1 MB
// default and surface as an empty list.
const EXEC_MAX_BUFFER = 64 * 1024 * 1024;
const EXEC_TIMEOUT_MS = 600_000;
const RESTIC_LONG_TIMEOUT_MS = 3_600_000; // backup / restore / prune / docker cp of data volumes move real data
const RESTIC_SNAPSHOTS_TIMEOUT_MS = 120_000;
const execFileAsync = (cmd: string, args: string[], opts: Record<string, unknown> = {}) =>
  rawExecFile(cmd, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER, ...opts });

/** Validate that a path is safe for use in docker exec/cp (no shell metacharacters, no traversal) */
function isValidContainerPath(p: string): boolean {
  return /^[a-zA-Z0-9/_\-]+$/.test(p) && !p.includes('..');
}

function getBackupTempDir(): string {
  const config = loadConfig();
  return `/tmp/${config.project.prefix}-backups`;
}

/**
 * Get Restic environment variables from an app's backup config
 */
function getResticEnv(app: AppDefinition): NodeJS.ProcessEnv {
  const backup = app.backup;

  if (!backup || !backup.enabled) {
    throw new ValidationError(`Backup not configured for app '${app.id}'`);
  }

  let repository: string;
  if (backup.s3?.endpoint_env && backup.s3?.bucket_env) {
    const endpoint = process.env[backup.s3.endpoint_env!];
    const bucket = process.env[backup.s3.bucket_env!];
    // Refuse plaintext S3 endpoints — credentials in headers would travel unencrypted.
    // Escape hatch for dev/localstack: OVERWATCH_ALLOW_INSECURE_S3=1.
    if (endpoint && endpoint.startsWith('http://') && process.env.OVERWATCH_ALLOW_INSECURE_S3 !== '1') {
      throw new ValidationError(
        `S3 endpoint '${endpoint}' uses http:// — refusing. Set OVERWATCH_ALLOW_INSECURE_S3=1 if you really intend this (e.g. localstack).`
      );
    }
    repository = `s3:${endpoint}/${bucket}`;
  } else {
    throw new ValidationError(`Invalid backup S3 configuration for app '${app.id}'`);
  }

  // Allowlist, not spread. `...process.env` leaked JWT_SECRET / GOOGLE_CLIENT_ID
  // / DB_ROOT_PASSWORD etc. into every restic/docker/mysqldump child, readable
  // via /proc/<pid>/environ to anyone in the same PID namespace.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    RESTIC_REPOSITORY: repository,
    RESTIC_PASSWORD: process.env[backup.restic_password_env || 'RESTIC_PASSWORD'],
  };

  if (backup.s3?.access_key_env) {
    env.AWS_ACCESS_KEY_ID = process.env[backup.s3.access_key_env];
  }
  if (backup.s3?.secret_key_env) {
    env.AWS_SECRET_ACCESS_KEY = process.env[backup.s3.secret_key_env];
  }

  return env;
}

export interface BackupSnapshot {
  id: string;
  shortId: string;
  time: string;
  hostname: string;
  tags: string[];
  paths: string[];
  appId?: string;
  tenantId?: string;
  size?: string;
}

export interface BackupInfo {
  configured: boolean;
  initialized: boolean;
  error?: string;
}

export interface LockInfo {
  pid?: string;
  host?: string;
  user?: string;
  createdAt?: string;
  age?: string;
}

function parseLockInfo(errorMsg: string): LockInfo | null {
  // Cap upstream restic stderr so the regexes below run on a bounded input.
  errorMsg = errorMsg.slice(0, 4096);
  const lockInfo: LockInfo = {};

  const pidMatch = errorMsg.match(/PID (\d+)/);
  if (pidMatch) lockInfo.pid = pidMatch[1];

  const hostMatch = errorMsg.match(/on ([a-f0-9]+) by/);
  if (hostMatch) lockInfo.host = hostMatch[1];

  const userMatch = errorMsg.match(/by ([^\s(]+)/g);
  if (userMatch && userMatch.length > 1) {
    lockInfo.user = userMatch[1].replace('by ', '');
  }

  const createdMatch = errorMsg.match(/created at ([0-9-]+ [0-9:]+)/);
  if (createdMatch) lockInfo.createdAt = createdMatch[1];

  const ageMatch = errorMsg.match(/\(([^)]+) ago\)/);
  if (ageMatch) lockInfo.age = ageMatch[1];

  return Object.keys(lockInfo).length > 0 ? lockInfo : null;
}

export async function getBackupInfo(appId: string): Promise<BackupInfo & { isLocked?: boolean; lockInfo?: LockInfo }> {
  const app = await getApp(appId);
  if (!app) {
    return { configured: false, initialized: false, error: `App '${appId}' not found` };
  }

  const backup = app.backup;
  if (!backup?.enabled) {
    return { configured: false, initialized: false, error: 'Backup not enabled for this app.' };
  }

  // Check required environment variables
  if (backup.provider === 's3' && backup.s3) {
    const requiredEnvVars = [
      backup.restic_password_env,
      backup.s3.access_key_env,
      backup.s3.secret_key_env,
    ].filter(Boolean);

    for (const envVar of requiredEnvVars) {
      if (!process.env[envVar!]) {
        return { configured: false, initialized: false, error: `Missing environment variable: ${envVar}` };
      }
    }
  }

  try {
    await execFileAsync('restic', ['cat', 'config'], { env: getResticEnv(app), timeout: 30000 });
    return { configured: true, initialized: true };
  } catch (error: any) {
    const errorMsg = error.stderr || error.message || '';
    if (errorMsg.includes('repository does not exist') || errorMsg.includes('Is there a repository at')) {
      return { configured: true, initialized: false };
    }
    if (errorMsg.includes('repository is already locked')) {
      const lockInfo = parseLockInfo(errorMsg);
      return { configured: true, initialized: true, isLocked: true, lockInfo: lockInfo || undefined, error: 'Repository is locked by another operation.' };
    }
    console.error('Backup status check failed:', errorMsg);
    return { configured: true, initialized: true, error: 'Failed to check backup status. Check server logs.' };
  }
}

export async function initializeRepository(appId: string): Promise<void> {
  const app = await getApp(appId);
  if (!app) throw new NotFoundError(`App '${appId}' not found`);
  try {
    await execFileAsync('restic', ['init'], { env: getResticEnv(app) });
  } catch (err: any) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(500, `Failed to initialize repository: ${err?.stderr?.toString().trim() || err?.message || err}`, { expose: true });
  }
  invalidateBackupCache(appId);
}

/**
 * Remove stale repository locks. `force` also removes live ones (`--remove-all`),
 * which breaks a backup or prune that is running right now: break-glass only.
 */
export async function unlockRepository(appId: string, options: { force?: boolean } = {}): Promise<{ success: boolean; error?: string }> {
  const app = await getApp(appId);
  if (!app) return { success: false, error: `App '${appId}' not found` };

  try {
    await execFileAsync('restic', options.force ? ['unlock', '--remove-all'] : ['unlock'], { env: getResticEnv(app), timeout: 30000 });
    invalidateBackupCache(appId);
    return { success: true };
  } catch (error: any) {
    console.error('[Backup] Unlock failed:', error.message);
    return { success: false, error: 'Failed to unlock repository. Check server logs.' };
  }
}

function formatError(error: any): { error: string; isLocked?: boolean; lockInfo?: LockInfo } {
  const msg = error.stderr || error.message || '';
  if (msg.includes('repository is already locked')) {
    const lockInfo = parseLockInfo(msg);
    return { error: 'Repository is locked by another operation.', isLocked: true, lockInfo: lockInfo || undefined };
  }
  // Return generic message to client; full error is logged server-side
  console.error('[Backup] Operation failed:', msg);
  return { error: 'Backup operation failed. Check server logs for details.' };
}

export async function listSnapshots(appId: string, tenantId?: string): Promise<BackupSnapshot[]> {
  const info = await getBackupInfo(appId);
  if (!info.configured || !info.initialized) {
    return [];
  }

  const app = await getApp(appId);
  if (!app) return [];

  try {
    // Apps may share an S3 bucket, so the repo is NOT app-scoped — filter by
    // app: tag to keep counts per-app correct. Restic ORs across multiple
    // --tag flags but ANDs across comma-separated values within ONE flag, so
    // pack both tags into a single --tag.
    const tags = [`app:${appId}`];
    if (tenantId) tags.push(`tenant:${tenantId}`);
    const args = ['snapshots', '--json', '--tag', tags.join(',')];

    const { stdout } = await execFileAsync('restic', args, { env: getResticEnv(app), timeout: RESTIC_SNAPSHOTS_TIMEOUT_MS });
    const snapshots = JSON.parse(stdout || '[]') as any[];

    return snapshots.map(s => ({
      id: s.id,
      shortId: s.short_id,
      time: s.time,
      hostname: s.hostname,
      tags: s.tags || [],
      paths: s.paths || [],
      appId: s.tags?.find((t: string) => t.startsWith('app:'))?.replace('app:', ''),
      tenantId: s.tags?.find((t: string) => t.startsWith('tenant:'))?.replace('tenant:', ''),
    })).sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  } catch (error) {
    // Rethrow: an empty list here would be cached as "no backups" and hide a
    // real failure (timeout, output overflow, unreachable repository).
    console.error('Failed to list snapshots:', error);
    throw error;
  }
}

export async function createBackup(appId: string, tenantId: string): Promise<{ success: boolean; snapshotId?: string; error?: string; isLocked?: boolean; lockInfo?: LockInfo }> {
  // Read the tenant's frozen definition rather than the global apps.d/ one:
  // we want to back up exactly what THIS tenant actually runs, which may
  // differ from a sibling tenant on a different image version. Falls back
  // to the global definition if the tenant has no snapshot yet (legacy
  // pre-v1.5.5 tenants, seeded at boot).
  const app = await readTenantAppDef(appId, tenantId);
  if (!app) return { success: false, error: `App '${appId}' not found` };

  const info = await getBackupInfo(appId);
  if (!info.configured) {
    return { success: false, error: 'Backup not configured' };
  }

  if (!info.initialized) {
    try {
      await initializeRepository(appId);
    } catch (error: any) {
      console.error('[Backup] Failed to initialize repository:', error.message);
      return { success: false, error: 'Failed to initialize backup repository. Check server logs.' };
    }
  }

  const config = loadConfig();
  const db = getDatabaseAdapter(app);

  // Get backup-enabled services from THIS tenant's app definition. A sibling
  // tenant on a different image version may have a different service list;
  // that's intentional — tenants are isolated.
  const backupServices = app.services
    .filter(s => s.backup?.enabled && s.backup?.paths?.length)
    .map(s => ({
      name: s.name,
      paths: s.backup!.paths!,
    }));

  const timestamp = Date.now();
  const backupDir = path.join(getBackupTempDir(), `backup-${timestamp}`);

  try {
    await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });

    const tenant = await getTenantInfo(appId, tenantId);
    if (!tenant) {
      return { success: false, error: `Tenant ${tenantId} not found in app ${appId}` };
    }

    const tenantBackupDir = path.join(backupDir, tenant.tenantId);
    await fs.mkdir(tenantBackupDir, { recursive: true, mode: 0o700 });

    // Dump database using adapter. DB-dump failures throw out to the outer
    // try/catch so the backup is reported as failed — do NOT swallow, or restic
    // will happily archive a folder without database.sql and the scheduler will
    // report success while the backup is silently unrestorable.
    const dbName = await resolveTenantDbId(appId, tenantId, app);
    await db.initialize();
    await db.dumpDatabase(dbName, path.join(tenantBackupDir, 'database.sql'));

    // Copy tenant .env — required artifact. Fail the backup if missing or unreadable.
    const tenantConfigDir = tenantDir(appId, tenant.tenantId);
    const envContent = await fs.readFile(path.join(tenantConfigDir, '.env'), 'utf-8');
    await fs.writeFile(path.join(tenantBackupDir, '.env'), envContent, { mode: 0o600 });

    // Copy paths from services that have backup enabled. Per-path failures are
    // recorded in metadata so restore can flag incompleteness — they no longer
    // silently disappear into console.error.
    const incompletePaths: Array<{ service: string; path: string; error: string }> = [];
    for (const service of backupServices) {
      const containerName = `${appId}-${tenant.tenantId}-${service.name}`;

      for (const pathConfig of service.paths) {
        try {
          if (!isValidContainerPath(pathConfig.container)) {
            console.error(`Skipping unsafe container path: ${pathConfig.container}`);
            incompletePaths.push({ service: service.name, path: pathConfig.container, error: 'unsafe path' });
            continue;
          }
          if (!isValidContainerPath(pathConfig.local)) {
            console.error(`Skipping unsafe local path: ${pathConfig.local}`);
            incompletePaths.push({ service: service.name, path: pathConfig.local, error: 'unsafe path' });
            continue;
          }
          // Only a missing directory counts as empty; any other exec failure
          // (container stopped, daemon error) means the path was not backed up.
          let checkOutput = '';
          try {
            ({ stdout: checkOutput } = await execFileAsync(
              'docker', ['exec', containerName, 'ls', '-A', pathConfig.container]
            ));
          } catch (lsErr: any) {
            const detail = `${lsErr?.stderr || ''} ${lsErr?.message || ''}`;
            if (!/No such file or directory/i.test(detail)) throw lsErr;
          }
          if (checkOutput.trim()) {
            const localDir = path.join(tenantBackupDir, pathConfig.local);
            await fs.mkdir(localDir, { recursive: true });
            await execFileAsync('docker', ['cp', `${containerName}:${pathConfig.container}/.`, `${localDir}/`], { timeout: RESTIC_LONG_TIMEOUT_MS });
          }
        } catch (error: any) {
          const msg = error?.message || String(error);
          console.error(`Failed to copy ${pathConfig.container} from ${containerName}: ${msg}`);
          incompletePaths.push({ service: service.name, path: pathConfig.container, error: msg });
        }
      }
    }

    // Create metadata file. `incomplete: true` when any optional service path failed
    // — restore consumers can refuse or warn.
    const metadata = {
      timestamp: new Date().toISOString(),
      appId,
      tenants: [tenant.tenantId],
      project: config.project.name,
      version: '2.1',
      ...(incompletePaths.length > 0 ? { incomplete: true, missingPaths: incompletePaths } : {}),
    };
    await writeJsonAtomic(path.join(backupDir, 'metadata.json'), metadata, { mode: 0o644 });

    // Run restic backup with app and tenant tags (execFile avoids shell injection)
    const { stdout } = await execFileAsync(
      'restic', ['backup', backupDir, '--tag', `app:${appId}`, '--tag', `tenant:${tenantId}`, '--json'],
      { env: getResticEnv(app), timeout: RESTIC_LONG_TIMEOUT_MS }
    );

    // Parse output to get snapshot ID
    const lines = stdout.trim().split('\n');
    const summaryLine = lines.find(l => l.includes('"message_type":"summary"'));
    let snapshotId = '';
    if (summaryLine) {
      const summary = JSON.parse(summaryLine);
      snapshotId = summary.snapshot_id;
    }

    invalidateBackupCache(appId);
    return { success: true, snapshotId };
  } catch (error: any) {
    console.error('Backup failed:', error);
    const formatted = formatError(error);
    return { success: false, ...formatted };
  } finally {
    try {
      await fs.rm(backupDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

export interface BackupAllResult {
  success: boolean;
  results: Array<{ appId: string; tenantId: string; success: boolean; snapshotId?: string; error?: string }>;
  successCount: number;
  failCount: number;
}

export async function backupAllTenants(appId?: string): Promise<BackupAllResult> {
  const tenants = await listTenants();
  const filtered = appId ? tenants.filter(t => t.appId === appId) : tenants;
  const results: BackupAllResult['results'] = [];
  let successCount = 0;
  let failCount = 0;

  for (const tenant of filtered) {
    const result = await createBackup(tenant.appId, tenant.tenantId);
    results.push({
      appId: tenant.appId,
      tenantId: tenant.tenantId,
      success: result.success,
      snapshotId: result.snapshotId,
      error: result.error,
    });
    if (result.success) {
      successCount++;
    } else {
      failCount++;
    }
  }

  return {
    success: failCount === 0,
    results,
    successCount,
    failCount,
  };
}

export interface RestoreBackupOptions {
  createNew?: boolean;
  newDomain?: string;
  /** The tenant's containers exist but are stopped (create-from-backup): copy without `exec`. */
  containersStopped?: boolean;
}
export type RestoreBackupResult = { success: boolean; warnings?: string[]; error?: string; isLocked?: boolean; lockInfo?: LockInfo };

/** Serialised with the tenant's other lifecycle operations. */
export function restoreBackup(
  appId: string,
  snapshotId: string,
  targetTenantId: string,
  options: RestoreBackupOptions = {},
): Promise<RestoreBackupResult> {
  return withTenantLock(appId, targetTenantId, () => restoreBackupLocked(appId, snapshotId, targetTenantId, options));
}

/** Caller must hold the tenant lock (withTenantLock) for appId/targetTenantId. */
export async function restoreBackupLocked(
  appId: string,
  snapshotId: string,
  targetTenantId: string,
  options: RestoreBackupOptions = {},
): Promise<RestoreBackupResult> {
  const app = await getApp(appId);
  if (!app) return { success: false, error: `App '${appId}' not found` };

  const info = await getBackupInfo(appId);
  if (!info.configured || !info.initialized) {
    return { success: false, error: 'Backup not configured or initialized' };
  }

  const db = getDatabaseAdapter(app);

  const timestamp = Date.now();
  const restoreDir = path.join(getBackupTempDir(), `restore-${timestamp}`);

  try {
    // Inside the try: an invalid tenant snapshot is reported like any other restore failure.
  // The tenant's own snapshot decides which services/paths exist for it (it may
  // run a different image version than the global definition); falls back to
  // the global definition when the tenant has none.
  const tenantApp = (await readTenantAppDef(appId, targetTenantId)) ?? app;
  const backupServices = tenantApp.services
    .filter(s => s.backup?.enabled && s.backup?.paths?.length)
    .map(s => ({
      name: s.name,
      paths: s.backup!.paths!,
    }));

    await fs.mkdir(restoreDir, { recursive: true, mode: 0o700 });

    // Restore from restic (execFile avoids shell injection on snapshotId)
    await execFileAsync(
      'restic', ['restore', snapshotId, '--target', restoreDir],
      { env: getResticEnv(app), timeout: RESTIC_LONG_TIMEOUT_MS }
    );

    // Find the backup data
    const { stdout: findOutput } = await execFileAsync('find', [restoreDir, '-name', 'metadata.json', '-type', 'f']);
    const metadataPath = findOutput.trim();
    if (!metadataPath) {
      return { success: false, error: 'Invalid backup: metadata.json not found' };
    }

    // Verify metadata path is within the restore directory (prevents symlink attacks)
    await assertWithinDir(metadataPath, restoreDir);

    const backupDataDir = path.dirname(metadataPath);
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));

    // Refuse archives that don't belong to this app — prevents restoring a
    // snapshot from a sibling/attacker-controlled app into the target tree.
    if (metadata.appId && metadata.appId !== appId) {
      return { success: false, error: `Backup appId mismatch: archive is for '${metadata.appId}', not '${appId}'` };
    }

    // Find the tenant data in the backup
    let sourceTenantId = targetTenantId;
    if (metadata.tenants && metadata.tenants.length > 0) {
      if (metadata.tenants.length === 1) {
        sourceTenantId = metadata.tenants[0];
      } else if (!metadata.tenants.includes(targetTenantId)) {
        return { success: false, error: `Tenant ${targetTenantId} not found in backup. Available: ${metadata.tenants.join(', ')}` };
      }
    }

    const tenantBackupDir = path.join(backupDataDir, sourceTenantId);
    try {
      await fs.access(tenantBackupDir);
      // Verify the resolved path is within the restore directory (prevents symlink attacks)
      await assertWithinDir(tenantBackupDir, restoreDir);
    } catch (e: any) {
      if (e.message?.includes('resolves outside')) {
        return { success: false, error: 'Backup contains unsafe symlinks' };
      }
      return { success: false, error: `Tenant data not found in backup for ${sourceTenantId}` };
    }

    if (options.createNew && !options.newDomain) {
      return { success: false, error: 'Domain required for new tenant' };
    }

    // Restore database using adapter
    const dbName = await resolveTenantDbId(appId, targetTenantId, app);
    const sqlFile = path.join(tenantBackupDir, 'database.sql');
    try {
      await fs.access(sqlFile);
      await db.initialize();
      await db.restoreDatabase(dbName, sqlFile);
    } catch (error: any) {
      console.error('[Backup] Failed to restore database:', error.message);
      return { success: false, error: 'Failed to restore database. Check server logs.' };
    }

    const warnings: string[] = [];
    if (metadata.incomplete) {
      // Only fixed text plus well-formed container paths: metadata comes from the archive.
      const missing = Array.isArray(metadata.missingPaths)
        ? metadata.missingPaths
            .map((m: any) => m?.path)
            .filter((m: unknown): m is string => typeof m === 'string' && isValidContainerPath(m))
        : [];
      warnings.push(`The backup was incomplete when taken${missing.length ? `; missing paths: ${missing.join(', ')}` : ''}`);
    }

    // Restore paths to service containers
    for (const service of backupServices) {
      const containerName = `${appId}-${targetTenantId}-${service.name}`;

      for (const pathConfig of service.paths) {
        try {
          if (!isValidContainerPath(pathConfig.container)) {
            console.error(`Skipping unsafe container path: ${pathConfig.container}`);
            warnings.push(`${service.name}: a configured path was skipped (unsafe path)`);
            continue;
          }
          if (!isValidContainerPath(pathConfig.local)) {
            console.error(`Skipping unsafe local path: ${pathConfig.local}`);
            warnings.push(`${service.name}: a configured path was skipped (unsafe path)`);
            continue;
          }
          const localBackupDir = path.join(tenantBackupDir, pathConfig.local);
          try {
            await fs.access(localBackupDir);
          } catch (accessErr: any) {
            if (accessErr?.code === 'ENOENT') continue; // path was empty/absent when the backup was taken
            console.error(`[Backup] Cannot read ${localBackupDir} from the backup: ${accessErr?.message || accessErr}`);
            warnings.push(`${pathConfig.container}: not restored (backup data unreadable; see server logs)`);
            continue;
          }
          // A stopped container cannot exec; docker cp into its volume mount points works.
          if (!options.containersStopped) {
            await execFileAsync('docker', ['exec', containerName, 'mkdir', '-p', pathConfig.container]);
          }
          await execFileAsync('docker', ['cp', `${localBackupDir}/.`, `${containerName}:${pathConfig.container}/`], { timeout: RESTIC_LONG_TIMEOUT_MS });
        } catch (error: any) {
          console.error(`[Backup] Failed to restore ${pathConfig.container} into ${containerName}: ${error?.message || error}`);
          warnings.push(`${pathConfig.container}: not restored (copy failed; see server logs)`);
        }
      }
    }

    return warnings.length > 0 ? { success: true, warnings } : { success: true };
  } catch (error: any) {
    console.error('Restore failed:', error);
    const formatted = formatError(error);
    return { success: false, ...formatted };
  } finally {
    try {
      await fs.rm(restoreDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Whether `snapshotId` names exactly one snapshot tagged for this app. Apps may
 * share a repository, and a `--tag` filter cannot scope an id: restic ignores
 * filters when explicit snapshot ids are given.
 */
async function snapshotBelongsToApp(app: AppDefinition, snapshotId: string): Promise<boolean> {
  const { stdout } = await execFileAsync('restic', ['snapshots', '--json', snapshotId], {
    env: getResticEnv(app),
    timeout: RESTIC_SNAPSHOTS_TIMEOUT_MS,
  });
  const found = JSON.parse(stdout || '[]') as Array<{ tags?: string[] }>;
  return found.length === 1 && (found[0].tags ?? []).includes(`app:${app.id}`);
}

export async function deleteSnapshot(appId: string, snapshotId: string): Promise<{ success: boolean; error?: string; isLocked?: boolean; lockInfo?: LockInfo }> {
  const app = await getApp(appId);
  if (!app) return { success: false, error: `App '${appId}' not found` };

  let owned: boolean;
  try {
    owned = await snapshotBelongsToApp(app, snapshotId);
  } catch (error: any) {
    return { success: false, ...formatError(error) };
  }
  if (!owned) throw new NotFoundError(`Snapshot '${snapshotId}' not found for app '${appId}'`);

  try {
    await execFileAsync('restic', ['forget', snapshotId], {
      env: getResticEnv(app),
      timeout: 60000
    });
    invalidateBackupCache(appId);
    return { success: true };
  } catch (error: any) {
    const formatted = formatError(error);
    return { success: false, ...formatted };
  }
}

export interface RetentionPolicy {
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { keepDaily: 7, keepWeekly: 4, keepMonthly: 12 };

export interface PruneSnapshotRef {
  id: string;
  shortId: string;
  time: string;
  tenantId?: string;
  tags: string[];
}

export interface PruneResult {
  success: boolean;
  error?: string;
  dryRun?: boolean;
  /** Dry run only: the snapshots the policy would forget. */
  remove?: PruneSnapshotRef[];
  removeCount?: number;
  keepCount?: number;
}

export async function pruneBackups(
  appId: string,
  policy: Partial<RetentionPolicy> = {},
  options: { dryRun?: boolean } = {},
): Promise<PruneResult> {
  const { keepDaily, keepWeekly, keepMonthly } = { ...DEFAULT_RETENTION, ...policy };
  if (keepDaily + keepWeekly + keepMonthly === 0) {
    throw new ValidationError('Refusing a retention policy that keeps no snapshots');
  }

  const app = await getApp(appId);
  if (!app) return { success: false, error: `App '${appId}' not found` };

  // Each snapshot path is a unique temp dir, so restic's default host+paths
  // grouping puts every snapshot in its own group and forgets nothing. Group by
  // the tag set (app:X + tenant:Y, plus e.g. pre-restore) instead, and filter on
  // app:X: the repository may be shared with other apps, which this app's
  // policy must never touch.
  const args = [
    'forget', '--tag', `app:${appId}`, '--group-by', 'tags',
    '--keep-daily', String(keepDaily),
    '--keep-weekly', String(keepWeekly),
    '--keep-monthly', String(keepMonthly),
    ...(options.dryRun ? ['--dry-run', '--json'] : ['--prune']),
  ];

  try {
    const { stdout } = await execFileAsync('restic', args, { env: getResticEnv(app), timeout: RESTIC_LONG_TIMEOUT_MS });
    if (options.dryRun) return { dryRun: true, ...summarizeForgetPlan(stdout) };
    invalidateBackupCache(appId);
    return { success: true };
  } catch (error: any) {
    if (error instanceof HttpError) throw error;
    console.error('[Backup] Prune failed:', error.message);
    return { success: false, error: 'Prune operation failed. Check server logs.' };
  }
}

/** Parse `restic forget --json` output (one entry per group, each with keep/remove lists). */
function summarizeForgetPlan(stdout: string): Required<Pick<PruneResult, 'success' | 'remove' | 'removeCount' | 'keepCount'>> {
  const groups = JSON.parse(stdout || '[]') as Array<{ keep?: any[] | null; remove?: any[] | null }>;
  const remove: PruneSnapshotRef[] = [];
  let keepCount = 0;
  for (const g of groups) {
    keepCount += g.keep?.length ?? 0;
    for (const s of g.remove ?? []) {
      const tags: string[] = s.tags || [];
      remove.push({
        id: s.id,
        shortId: s.short_id,
        time: s.time,
        tenantId: tags.find(t => t.startsWith('tenant:'))?.slice('tenant:'.length),
        tags,
      });
    }
  }
  return { success: true, remove, removeCount: remove.length, keepCount };
}
