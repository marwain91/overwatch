import { Router } from 'express';
import {
  getBackupInfo,
  initializeRepository,
  unlockRepository,
  listSnapshots,
  createBackup,
  backupAllTenants,
  restoreBackup,
  deleteSnapshot,
  pruneBackups,
} from '../services/backup';
import { createTenant } from '../services/tenant';
import { getTenantInfo } from '../services/docker';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router({ mergeParams: true });

// Get backup configuration status for an app
router.get('/status', asyncHandler(async (req, res) => {
  const { appId } = req.params;
  const info = await getBackupInfo(appId);
  res.json(info);
}));

// Initialize backup repository for an app
router.post('/init', asyncHandler(async (req, res) => {
  const { appId } = req.params;
  await initializeRepository(appId);
  res.json({ success: true, message: 'Repository initialized' });
}));

// Unlock repository
router.post('/unlock', asyncHandler(async (req, res) => {
  const { appId } = req.params;
  const result = await unlockRepository(appId);
  if (result.success) {
    res.json({ success: true, message: 'Repository unlocked' });
  } else {
    res.status(500).json({ error: result.error });
  }
}));

// List all backup snapshots for an app
router.get('/', asyncHandler(async (req, res) => {
  const { appId } = req.params;
  const tenantId = req.query.tenantId as string | undefined;
  const snapshots = await listSnapshots(appId, tenantId);
  res.json(snapshots);
}));

// Create a new backup for a specific tenant
router.post('/', asyncHandler(async (req, res) => {
  const { appId } = req.params;
  const { tenantId } = req.body;

  if (!tenantId) {
    return res.status(400).json({ error: 'tenantId is required' });
  }

  const result = await createBackup(appId, tenantId);

  if (result.success) {
    res.json({ success: true, snapshotId: result.snapshotId });
  } else {
    res.status(500).json({ error: result.error, isLocked: result.isLocked, lockInfo: result.lockInfo });
  }
}));

// Backup all tenants for an app
router.post('/all', asyncHandler(async (req, res) => {
  const { appId } = req.params;
  const result = await backupAllTenants(appId);
  res.json(result);
}));

// Restore a backup to existing tenant
router.post('/:snapshotId/restore', asyncHandler(async (req, res) => {
  const { appId, snapshotId } = req.params;
  const { tenantId } = req.body;

  if (!tenantId) {
    return res.status(400).json({ error: 'tenantId is required' });
  }

  const tenant = await getTenantInfo(appId, tenantId);
  if (!tenant) {
    return res.status(404).json({ error: `Tenant ${tenantId} not found` });
  }

  const result = await restoreBackup(appId, snapshotId, tenantId);

  if (result.success) {
    res.json({ success: true, message: `Backup restored to ${tenantId}` });
  } else {
    res.status(500).json({ error: result.error, isLocked: result.isLocked, lockInfo: result.lockInfo });
  }
}));

// Create new tenant from backup
router.post('/:snapshotId/create-tenant', asyncHandler(async (req, res) => {
  const { appId, snapshotId } = req.params;
  const { tenantId, domain, imageTag } = req.body;

  if (!tenantId || !domain) {
    return res.status(400).json({ error: 'tenantId and domain are required' });
  }

  await createTenant({ appId, tenantId, domain, imageTag: imageTag || 'latest' });

  // Wait a moment for the database to be ready
  await new Promise(resolve => setTimeout(resolve, 5000));

  const result = await restoreBackup(appId, snapshotId, tenantId, {
    createNew: true,
    newDomain: domain,
  });

  if (result.success) {
    res.json({
      success: true,
      message: `New tenant ${tenantId} created from backup`,
      appId,
      tenantId,
      domain,
    });
  } else {
    res.status(500).json({ error: result.error, isLocked: result.isLocked, lockInfo: result.lockInfo });
  }
}));

// Delete a backup snapshot
router.delete('/:snapshotId', asyncHandler(async (req, res) => {
  const { appId, snapshotId } = req.params;
  const result = await deleteSnapshot(appId, snapshotId);

  if (result.success) {
    res.json({ success: true });
  } else {
    res.status(500).json({ error: result.error, isLocked: result.isLocked, lockInfo: result.lockInfo });
  }
}));

// Prune old backups
router.post('/prune', asyncHandler(async (req, res) => {
  const { appId } = req.params;
  const { keepDaily = 7, keepWeekly = 4, keepMonthly = 12 } = req.body;
  const result = await pruneBackups(appId, keepDaily, keepWeekly, keepMonthly);

  if (result.success) {
    res.json({ success: true, message: 'Old backups pruned' });
  } else {
    res.status(500).json({ error: result.error });
  }
}));

export default router;
