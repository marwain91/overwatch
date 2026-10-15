import { createTenantLocked, startCreatedTenantLocked, deleteTenantLocked } from './tenant';
import { assertSnapshotOfApp, restoreBackupLocked } from './backup';
import { withTenantLock } from './fileLock';
import type { LockInfo } from './backup';

export interface TenantFromBackupOptions {
  tenantId: string;
  domain: string;
  /** Omitted: createTenant falls back to the app's default_image_tag, then 'latest'. */
  imageTag?: string;
}

export interface TenantFromBackupResult {
  success: boolean;
  warnings?: string[];
  error?: string;
  isLocked?: boolean;
  lockInfo?: LockInfo;
}

async function rollback(appId: string, tenantId: string): Promise<void> {
  try {
    await deleteTenantLocked(appId, tenantId, false);
  } catch (error: any) {
    // Never mask the original failure; the operator needs to clean up by hand.
    console.error(`[TenantFromBackup] Rollback of ${appId}/${tenantId} failed: ${error?.message || error}`);
  }
}

/**
 * Create a tenant and restore a backup snapshot into it, before the app has
 * ever started: create stopped (DB, files, containers) -> restore the DB and
 * the volume paths -> start (`up -d`, which runs the init containers against
 * the restored data). If anything after the tenant exists fails, the tenant
 * (containers, DB, files) is deleted again so a retry does not hit a
 * half-restored tenant. A failure of createTenant itself is thrown as-is: it
 * already cleans up after itself.
 *
 * The tenant lock is held for the whole sequence, so the unlocked variants of
 * create/restore/delete are used inside it (the lock is not re-entrant). The
 * snapshot is checked to be the app's before anything is created; any tenant's
 * snapshot of the app may be used (cross-tenant by design).
 */
export function createTenantFromBackup(
  appId: string,
  snapshotId: string,
  options: TenantFromBackupOptions,
): Promise<TenantFromBackupResult> {
  return withTenantLock(appId, options.tenantId, () => createTenantFromBackupLocked(appId, snapshotId, options));
}

async function createTenantFromBackupLocked(
  appId: string,
  snapshotId: string,
  options: TenantFromBackupOptions,
): Promise<TenantFromBackupResult> {
  const { tenantId, domain, imageTag } = options;

  await assertSnapshotOfApp(appId, snapshotId);
  await createTenantLocked({ appId, tenantId, domain, imageTag, start: false });

  try {
    const result = await restoreBackupLocked(appId, snapshotId, tenantId, {
      createNew: true,
      newDomain: domain,
      containersStopped: true,
    });
    if (!result.success) {
      await rollback(appId, tenantId);
      return { success: false, error: result.error, isLocked: result.isLocked, lockInfo: result.lockInfo };
    }

    try {
      await startCreatedTenantLocked(appId, tenantId);
    } catch (error: any) {
      console.error(`[TenantFromBackup] Start of ${appId}/${tenantId} after restore failed: ${error?.message || error}`);
      await rollback(appId, tenantId);
      return { success: false, error: `The backup was restored but the tenant failed to start; the new tenant was removed. ${error?.message || error}` };
    }
    return result.warnings?.length ? { success: true, warnings: result.warnings } : { success: true };
  } catch (error) {
    await rollback(appId, tenantId);
    throw error;
  }
}
