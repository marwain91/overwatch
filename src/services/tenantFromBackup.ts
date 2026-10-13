import { getApp } from './app';
import { createTenant, deleteTenant } from './tenant';
import { restartTenant } from './docker';
import { restoreBackup } from './backup';
import { getDatabaseAdapter } from '../adapters/database';
import type { LockInfo } from './backup';

export interface TenantFromBackupOptions {
  tenantId: string;
  domain: string;
  /** Omitted: createTenant falls back to the app's default_image_tag, then 'latest'. */
  imageTag?: string;
  dbReadyTimeoutMs?: number;
  dbPollIntervalMs?: number;
}

export interface TenantFromBackupResult {
  success: boolean;
  warnings?: string[];
  error?: string;
  isLocked?: boolean;
  lockInfo?: LockInfo;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function waitForDatabase(appId: string, timeoutMs: number, intervalMs: number): Promise<boolean> {
  const app = await getApp(appId);
  const db = getDatabaseAdapter(app ?? undefined);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await db.testConnection()) return true;
    if (Date.now() + intervalMs > deadline) return false;
    await sleep(intervalMs);
  }
}

async function rollback(appId: string, tenantId: string): Promise<void> {
  try {
    await deleteTenant(appId, tenantId, false);
  } catch (error: any) {
    // Never mask the original failure; the operator needs to clean up by hand.
    console.error(`[TenantFromBackup] Rollback of ${appId}/${tenantId} failed: ${error?.message || error}`);
  }
}

/**
 * Create a tenant and restore a backup snapshot into it. If anything after the
 * tenant exists fails, the tenant (containers, DB, files) is deleted again so a
 * retry does not hit a half-restored tenant. A failure of createTenant itself
 * is thrown as-is: it already cleans up after itself.
 */
export async function createTenantFromBackup(
  appId: string,
  snapshotId: string,
  options: TenantFromBackupOptions,
): Promise<TenantFromBackupResult> {
  const { tenantId, domain, imageTag, dbReadyTimeoutMs = 60_000, dbPollIntervalMs = 1_000 } = options;

  await createTenant({ appId, tenantId, domain, imageTag });

  try {
    if (!(await waitForDatabase(appId, dbReadyTimeoutMs, dbPollIntervalMs))) {
      await rollback(appId, tenantId);
      return { success: false, error: 'Database did not become ready in time; the new tenant was removed.' };
    }

    const result = await restoreBackup(appId, snapshotId, tenantId, { createNew: true, newDomain: domain });
    if (!result.success) {
      await rollback(appId, tenantId);
      return { success: false, error: result.error, isLocked: result.isLocked, lockInfo: result.lockInfo };
    }

    // The app started against an empty database; restart so it picks up the restored data.
    const warnings = [...(result.warnings ?? [])];
    try {
      await restartTenant(appId, tenantId);
    } catch (error: any) {
      console.error(`[TenantFromBackup] Restart of ${appId}/${tenantId} after restore failed: ${error?.message || error}`);
      warnings.push('The tenant was restored but could not be restarted; restart it manually.');
    }
    return warnings.length ? { success: true, warnings } : { success: true };
  } catch (error) {
    await rollback(appId, tenantId);
    throw error;
  }
}
