import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { loadConfig, resolveEnvValue, getAppsDir } from '../config';
import { getDatabaseAdapter } from '../adapters/database';
import { getTenantInfo, listTenants } from './docker';
import { getApp, listApps } from './app';
import { AppDefinition } from '../models/app';

const execFileAsync = promisify(execFile);

/** Validate that a path is safe for use in docker exec/cp (no shell metacharacters) */
function isValidContainerPath(p: string): boolean {
  return /^[a-zA-Z0-9/_.\-]+$/.test(p) && !p.includes('..');
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
    throw new Error(`Backup not configured for app '${app.id}'`);
  }

  let repository: string;
  if (backup.s3?.endpoint_env && backup.s3?.bucket_env) {
    const endpoint = process.env[backup.s3.endpoint_env!];
    const bucket = process.env[backup.s3.bucket_env!];
    repository = `s3:${endpoint}/${bucket}`;
  } else {
    throw new Error(`Invalid backup S3 configuration for app '${app.id}'`);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
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
  if (!app) throw new Error(`App '${appId}' not found`);
  await execFileAsync('restic', ['init'], { env: getResticEnv(app) });
}

export async function unlockRepository(appId: string): Promise<{ success: boolean; error?: string }> {
  const app = await getApp(appId);
  if (!app) return { success: false, error: `App '${appId}' not found` };

  try {
    await execFileAsync('restic', ['unlock', '--remove-all'], { env: getResticEnv(app), timeout: 30000 });
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
    const args = ['snapshots', '--json'];
    args.push('--tag', `app:${appId}`);
    if (tenantId) {
      args.push('--tag', `tenant:${tenantId}`);
    }

    const { stdout } = await execFileAsync('restic', args, { env: getResticEnv(app) });
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
    console.error('Failed to list snapshots:', error);
    return [];
  }
}

export async function createBackup(appId: string, tenantId: string): Promise<{ success: boolean; snapshotId?: string; error?: string; isLocked?: boolean; lockInfo?: LockInfo }> {
  const app = await getApp(appId);
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
  const db = getDatabaseAdapter();
  const appsDir = getAppsDir();

  // Get backup-enabled services from app definition
  const backupServices = app.services
    .filter(s => s.backup?.enabled && s.backup?.paths?.length)
    .map(s => ({
      name: s.name,
      paths: s.backup!.paths!,
    }));

  const timestamp = Date.now();
  const backupDir = path.join(getBackupTempDir(), `backup-${timestamp}`);

  try {
    await fs.mkdir(backupDir, { recursive: true });

    const tenant = await getTenantInfo(appId, tenantId);
    if (!tenant) {
      return { success: false, error: `Tenant ${tenantId} not found in app ${appId}` };
    }

    const tenantBackupDir = path.join(backupDir, tenant.tenantId);
    await fs.mkdir(tenantBackupDir, { recursive: true });

    // Dump database using adapter
    const dbPrefix = config.project.db_prefix;
    const dbName = `${dbPrefix}_${appId}_${tenantId}`;
    try {
      await db.initialize();
      await db.dumpDatabase(dbName, path.join(tenantBackupDir, 'database.sql'));
    } catch (error: any) {
      console.error(`Failed to dump database for ${tenant.tenantId}:`, error.message);
    }

    // Copy tenant config
    const tenantConfigDir = path.join(appsDir, appId, 'tenants', tenant.tenantId);
    try {
      const envContent = await fs.readFile(path.join(tenantConfigDir, '.env'), 'utf-8');
      await fs.writeFile(path.join(tenantBackupDir, '.env'), envContent);
    } catch (error) {
      console.error(`Failed to copy config for ${tenant.tenantId}`);
    }

    // Copy paths from services that have backup enabled
    for (const service of backupServices) {
      const containerName = `${appId}-${tenant.tenantId}-${service.name}`;

      for (const pathConfig of service.paths) {
        try {
          if (!isValidContainerPath(pathConfig.container)) {
            console.error(`Skipping unsafe container path: ${pathConfig.container}`);
            continue;
          }
          if (!isValidContainerPath(pathConfig.local)) {
            console.error(`Skipping unsafe local path: ${pathConfig.local}`);
            continue;
          }
          const { stdout: checkOutput } = await execFileAsync(
            'docker', ['exec', containerName, 'ls', '-A', pathConfig.container]
          ).catch(() => ({ stdout: '' }));
          if (checkOutput.trim()) {
            const localDir = path.join(tenantBackupDir, pathConfig.local);
            await fs.mkdir(localDir, { recursive: true });
            await execFileAsync('docker', ['cp', `${containerName}:${pathConfig.container}/.`, `${localDir}/`]);
          }
        } catch (error: any) {
          console.error(`Failed to copy ${pathConfig.container} from ${containerName}:`, error.message);
        }
      }
    }

    // Create metadata file
    const metadata = {
      timestamp: new Date().toISOString(),
      appId,
      tenants: [tenant.tenantId],
      project: config.project.name,
      version: '2.0',
    };
    await fs.writeFile(path.join(backupDir, 'metadata.json'), JSON.stringify(metadata, null, 2));

    // Run restic backup with app and tenant tags (execFile avoids shell injection)
    const { stdout } = await execFileAsync(
      'restic', ['backup', backupDir, '--tag', `app:${appId}`, '--tag', `tenant:${tenantId}`, '--json'],
      { env: getResticEnv(app) }
    );

    // Parse output to get snapshot ID
    const lines = stdout.trim().split('\n');
    const summaryLine = lines.find(l => l.includes('"message_type":"summary"'));
    let snapshotId = '';
    if (summaryLine) {
      const summary = JSON.parse(summaryLine);
      snapshotId = summary.snapshot_id;
    }

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

export async function restoreBackup(
  appId: string,
  snapshotId: string,
  targetTenantId: string,
  options: { createNew?: boolean; newDomain?: string } = {}
): Promise<{ success: boolean; error?: string; isLocked?: boolean; lockInfo?: LockInfo }> {
  const app = await getApp(appId);
  if (!app) return { success: false, error: `App '${appId}' not found` };

  const info = await getBackupInfo(appId);
  if (!info.configured || !info.initialized) {
    return { success: false, error: 'Backup not configured or initialized' };
  }

  const config = loadConfig();
  const db = getDatabaseAdapter();

  // Get backup-enabled services from app definition
  const backupServices = app.services
    .filter(s => s.backup?.enabled && s.backup?.paths?.length)
    .map(s => ({
      name: s.name,
      paths: s.backup!.paths!,
    }));

  const timestamp = Date.now();
  const restoreDir = path.join(getBackupTempDir(), `restore-${timestamp}`);

  try {
    await fs.mkdir(restoreDir, { recursive: true });

    // Restore from restic (execFile avoids shell injection on snapshotId)
    await execFileAsync(
      'restic', ['restore', snapshotId, '--target', restoreDir],
      { env: getResticEnv(app) }
    );

    // Find the backup data
    const { stdout: findOutput } = await execFileAsync('find', [restoreDir, '-name', 'metadata.json', '-type', 'f']);
    const metadataPath = findOutput.trim();
    if (!metadataPath) {
      return { success: false, error: 'Invalid backup: metadata.json not found' };
    }

    const backupDataDir = path.dirname(metadataPath);
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));

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
    } catch {
      return { success: false, error: `Tenant data not found in backup for ${sourceTenantId}` };
    }

    if (options.createNew && !options.newDomain) {
      return { success: false, error: 'Domain required for new tenant' };
    }

    // Restore database using adapter
    const dbPrefix = config.project.db_prefix;
    const dbName = `${dbPrefix}_${appId}_${targetTenantId}`;
    const sqlFile = path.join(tenantBackupDir, 'database.sql');
    try {
      await fs.access(sqlFile);
      await db.initialize();
      await db.restoreDatabase(dbName, sqlFile);
    } catch (error: any) {
      console.error('[Backup] Failed to restore database:', error.message);
      return { success: false, error: 'Failed to restore database. Check server logs.' };
    }

    // Restore paths to service containers
    for (const service of backupServices) {
      const containerName = `${appId}-${targetTenantId}-${service.name}`;

      for (const pathConfig of service.paths) {
        try {
          if (!isValidContainerPath(pathConfig.container)) {
            console.error(`Skipping unsafe container path: ${pathConfig.container}`);
            continue;
          }
          if (!isValidContainerPath(pathConfig.local)) {
            console.error(`Skipping unsafe local path: ${pathConfig.local}`);
            continue;
          }
          const localBackupDir = path.join(tenantBackupDir, pathConfig.local);
          await fs.access(localBackupDir);
          await execFileAsync('docker', ['exec', containerName, 'mkdir', '-p', pathConfig.container]);
          await execFileAsync('docker', ['cp', `${localBackupDir}/.`, `${containerName}:${pathConfig.container}/`]);
        } catch {
          // No data to restore or container not running
        }
      }
    }

    return { success: true };
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

export async function deleteSnapshot(appId: string, snapshotId: string): Promise<{ success: boolean; error?: string; isLocked?: boolean; lockInfo?: LockInfo }> {
  const app = await getApp(appId);
  if (!app) return { success: false, error: `App '${appId}' not found` };

  try {
    await execFileAsync('restic', ['forget', snapshotId], {
      env: getResticEnv(app),
      timeout: 60000
    });
    return { success: true };
  } catch (error: any) {
    const formatted = formatError(error);
    return { success: false, ...formatted };
  }
}

export async function pruneBackups(appId: string, keepDaily: number = 7, keepWeekly: number = 4, keepMonthly: number = 12): Promise<{ success: boolean; error?: string }> {
  const app = await getApp(appId);
  if (!app) return { success: false, error: `App '${appId}' not found` };

  try {
    await execFileAsync('restic', [
      'forget',
      '--keep-daily', String(keepDaily),
      '--keep-weekly', String(keepWeekly),
      '--keep-monthly', String(keepMonthly),
      '--prune',
    ], { env: getResticEnv(app) });
    return { success: true };
  } catch (error: any) {
    console.error('[Backup] Prune failed:', error.message);
    return { success: false, error: 'Prune operation failed. Check server logs.' };
  }
}
