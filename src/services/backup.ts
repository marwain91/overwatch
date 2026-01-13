import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { loadConfig, getContainerPrefix, getBackupServices, resolveEnvValue } from '../config';
import { getDatabaseAdapter } from '../adapters/database';
import { getTenantInfo, listTenants } from './docker';

const execAsync = promisify(exec);

function getTenantsDir(): string {
  return process.env.TENANTS_DIR || '/opt/overwatch/tenants';
}

function getBackupTempDir(): string {
  const config = loadConfig();
  return `/tmp/${config.project.prefix}-backups`;
}

/**
 * Get Restic environment variables from config
 */
function getResticEnv(): NodeJS.ProcessEnv {
  const config = loadConfig();
  const backup = config.backup;

  if (!backup) {
    throw new Error('Backup not configured');
  }

  let repository: string;
  if (backup.s3?.endpoint_template) {
    repository = resolveEnvValue(backup.s3.endpoint_template);
  } else if (backup.s3?.endpoint_env && backup.s3?.bucket_env) {
    const endpoint = process.env[backup.s3.endpoint_env];
    const bucket = process.env[backup.s3.bucket_env];
    repository = `s3:${endpoint}/${bucket}`;
  } else {
    throw new Error('Invalid backup S3 configuration');
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RESTIC_REPOSITORY: repository,
    RESTIC_PASSWORD: process.env[backup.restic_password_env],
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

export async function getBackupInfo(): Promise<BackupInfo & { isLocked?: boolean; lockInfo?: LockInfo }> {
  const config = loadConfig();
  const backup = config.backup;

  if (!backup?.enabled) {
    return { configured: false, initialized: false, error: 'Backup not enabled in configuration.' };
  }

  // Check required environment variables based on provider
  if (backup.provider === 's3') {
    const s3 = backup.s3;
    if (!s3) {
      return { configured: false, initialized: false, error: 'S3 backup configuration missing.' };
    }

    const requiredEnvVars = [
      backup.restic_password_env,
      s3.access_key_env,
      s3.secret_key_env,
    ].filter(Boolean);

    for (const envVar of requiredEnvVars) {
      if (!process.env[envVar!]) {
        return { configured: false, initialized: false, error: `Missing environment variable: ${envVar}` };
      }
    }
  }

  try {
    await execAsync('restic cat config', { env: getResticEnv(), timeout: 30000 });
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
    return { configured: true, initialized: true, error: errorMsg };
  }
}

export async function initializeRepository(): Promise<void> {
  await execAsync('restic init', { env: getResticEnv() });
}

export async function unlockRepository(): Promise<{ success: boolean; error?: string }> {
  try {
    await execAsync('restic unlock --remove-all', { env: getResticEnv(), timeout: 30000 });
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

function formatError(error: any): { error: string; isLocked?: boolean; lockInfo?: LockInfo } {
  const msg = error.stderr || error.message || '';
  if (msg.includes('repository is already locked')) {
    const lockInfo = parseLockInfo(msg);
    return { error: 'Repository is locked by another operation.', isLocked: true, lockInfo: lockInfo || undefined };
  }
  return { error: msg };
}

export async function listSnapshots(tenantId?: string): Promise<BackupSnapshot[]> {
  const info = await getBackupInfo();
  if (!info.configured || !info.initialized) {
    return [];
  }

  try {
    let cmd = 'restic snapshots --json';
    if (tenantId) {
      cmd += ` --tag tenant:${tenantId}`;
    }

    const { stdout } = await execAsync(cmd, { env: getResticEnv() });
    const snapshots = JSON.parse(stdout || '[]') as any[];

    return snapshots.map(s => ({
      id: s.id,
      shortId: s.short_id,
      time: s.time,
      hostname: s.hostname,
      tags: s.tags || [],
      paths: s.paths || [],
      tenantId: s.tags?.find((t: string) => t.startsWith('tenant:'))?.replace('tenant:', ''),
    })).sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  } catch (error) {
    console.error('Failed to list snapshots:', error);
    return [];
  }
}

export async function createBackup(tenantId: string): Promise<{ success: boolean; snapshotId?: string; error?: string; isLocked?: boolean; lockInfo?: LockInfo }> {
  const info = await getBackupInfo();
  if (!info.configured) {
    return { success: false, error: 'Backup not configured' };
  }

  if (!info.initialized) {
    try {
      await initializeRepository();
    } catch (error: any) {
      return { success: false, error: `Failed to initialize repository: ${error.message}` };
    }
  }

  const config = loadConfig();
  const prefix = getContainerPrefix();
  const backupServices = getBackupServices();
  const db = getDatabaseAdapter();
  const tenantsDir = getTenantsDir();

  const timestamp = Date.now();
  const backupDir = path.join(getBackupTempDir(), `backup-${timestamp}`);

  try {
    await fs.mkdir(backupDir, { recursive: true });

    const tenant = await getTenantInfo(tenantId);
    if (!tenant) {
      return { success: false, error: `Tenant ${tenantId} not found` };
    }

    const tenantBackupDir = path.join(backupDir, tenant.tenantId);
    await fs.mkdir(tenantBackupDir, { recursive: true });

    // Dump database using adapter
    try {
      await db.initialize();
      await db.dumpDatabase(tenantId, path.join(tenantBackupDir, 'database.sql'));
    } catch (error: any) {
      console.error(`Failed to dump database for ${tenant.tenantId}:`, error.message);
    }

    // Copy tenant config
    const tenantConfigDir = path.join(tenantsDir, tenant.tenantId);
    try {
      const envContent = await fs.readFile(path.join(tenantConfigDir, '.env'), 'utf-8');
      await fs.writeFile(path.join(tenantBackupDir, '.env'), envContent);
    } catch (error) {
      console.error(`Failed to copy config for ${tenant.tenantId}`);
    }

    // Copy paths from services that have backup enabled
    for (const service of backupServices) {
      const containerName = `${prefix}-${tenant.tenantId}-${service.name}`;

      for (const pathConfig of service.paths) {
        try {
          const { stdout: checkOutput } = await execAsync(
            `docker exec ${containerName} ls -A ${pathConfig.container} 2>/dev/null || echo ""`
          );
          if (checkOutput.trim()) {
            const localDir = path.join(tenantBackupDir, pathConfig.local);
            await fs.mkdir(localDir, { recursive: true });
            await execAsync(`docker cp ${containerName}:${pathConfig.container}/. "${localDir}/"`);
          }
        } catch (error: any) {
          console.error(`Failed to copy ${pathConfig.container} from ${containerName}:`, error.message);
        }
      }
    }

    // Create metadata file
    const metadata = {
      timestamp: new Date().toISOString(),
      tenants: [tenant.tenantId],
      project: config.project.name,
      version: '1.0',
    };
    await fs.writeFile(path.join(backupDir, 'metadata.json'), JSON.stringify(metadata, null, 2));

    // Run restic backup with tenant tag
    const { stdout } = await execAsync(
      `restic backup "${backupDir}" --tag tenant:${tenantId} --json`,
      { env: getResticEnv() }
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
  results: Array<{ tenantId: string; success: boolean; snapshotId?: string; error?: string }>;
  successCount: number;
  failCount: number;
}

export async function backupAllTenants(): Promise<BackupAllResult> {
  const tenants = await listTenants();
  const results: BackupAllResult['results'] = [];
  let successCount = 0;
  let failCount = 0;

  for (const tenant of tenants) {
    const result = await createBackup(tenant.tenantId);
    results.push({
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
  snapshotId: string,
  targetTenantId: string,
  options: { createNew?: boolean; newDomain?: string } = {}
): Promise<{ success: boolean; error?: string; isLocked?: boolean; lockInfo?: LockInfo }> {
  const info = await getBackupInfo();
  if (!info.configured || !info.initialized) {
    return { success: false, error: 'Backup not configured or initialized' };
  }

  const config = loadConfig();
  const prefix = getContainerPrefix();
  const backupServices = getBackupServices();
  const db = getDatabaseAdapter();

  const timestamp = Date.now();
  const restoreDir = path.join(getBackupTempDir(), `restore-${timestamp}`);

  try {
    await fs.mkdir(restoreDir, { recursive: true });

    // Restore from restic
    await execAsync(
      `restic restore ${snapshotId} --target "${restoreDir}"`,
      { env: getResticEnv() }
    );

    // Find the backup data (nested in the temp path structure)
    const { stdout: findOutput } = await execAsync(`find "${restoreDir}" -name "metadata.json" -type f`);
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

    if (options.createNew) {
      if (!options.newDomain) {
        return { success: false, error: 'Domain required for new tenant' };
      }
    }

    // Restore database using adapter
    const sqlFile = path.join(tenantBackupDir, 'database.sql');
    try {
      await fs.access(sqlFile);
      await db.initialize();
      await db.restoreDatabase(targetTenantId, sqlFile);
    } catch (error: any) {
      console.error('Failed to restore database:', error.message);
      return { success: false, error: `Failed to restore database: ${error.message}` };
    }

    // Restore paths to service containers
    for (const service of backupServices) {
      const containerName = `${prefix}-${targetTenantId}-${service.name}`;

      for (const pathConfig of service.paths) {
        const localBackupDir = path.join(tenantBackupDir, pathConfig.local);
        try {
          await fs.access(localBackupDir);
          await execAsync(`docker exec ${containerName} mkdir -p ${pathConfig.container}`);
          await execAsync(`docker cp "${localBackupDir}/." ${containerName}:${pathConfig.container}/`);
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

export async function deleteSnapshot(snapshotId: string): Promise<{ success: boolean; error?: string; isLocked?: boolean; lockInfo?: LockInfo }> {
  try {
    await execAsync(`restic forget ${snapshotId}`, {
      env: getResticEnv(),
      timeout: 60000
    });
    return { success: true };
  } catch (error: any) {
    const formatted = formatError(error);
    return { success: false, ...formatted };
  }
}

export async function pruneBackups(keepDaily: number = 7, keepWeekly: number = 4, keepMonthly: number = 12): Promise<{ success: boolean; error?: string }> {
  try {
    await execAsync(
      `restic forget --keep-daily ${keepDaily} --keep-weekly ${keepWeekly} --keep-monthly ${keepMonthly} --prune`,
      { env: getResticEnv() }
    );
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}
