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
import { getApp } from '../services/app';
import { createTenant } from '../services/tenant';
import { getTenantInfo } from '../services/docker';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router({ mergeParams: true });

// Restic snapshot IDs are short hex strings
function isValidSnapshotId(id: string): boolean {
  return /^[a-f0-9]{8,64}$/.test(id);
}

function isValidTenantId(id: string): boolean {
  return id.length <= 63 && /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(id);
}

// Get backup summary (status + latest snapshot info)
router.get('/summary', asyncHandler(async (req, res) => {
  const { appId } = req.params;
  const app = await getApp(appId);
  if (!app) {
    return res.status(404).json({ error: 'App not found' });
  }

  const info = await getBackupInfo(appId);

  let lastBackup: string | null = null;
  let totalSnapshots = 0;

  if (info.configured && info.initialized) {
    const snapshots = await listSnapshots(appId);
    totalSnapshots = snapshots.length;
    if (snapshots.length > 0) {
      lastBackup = snapshots[0].time; // already sorted desc
    }
  }

  // Resolve non-secret config values for display
  let bucket: string | null = null;
  let endpoint: string | null = null;
  if (app.backup?.s3?.bucket_env) {
    bucket = process.env[app.backup.s3.bucket_env] || null;
  }
  if (app.backup?.s3?.endpoint_env) {
    endpoint = process.env[app.backup.s3.endpoint_env] || null;
  }

  res.json({
    ...info,
    schedule: app.backup?.schedule || null,
    lastBackup,
    totalSnapshots,
    bucket,
    endpoint,
  });
}));

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

// List backup snapshots for an app (optionally filtered by tenant and/or month)
router.get('/', asyncHandler(async (req, res) => {
  const { appId } = req.params;
  const tenantId = req.query.tenantId as string | undefined;
  const year = req.query.year ? Number(req.query.year) : undefined;
  const month = req.query.month ? Number(req.query.month) : undefined;

  let snapshots = await listSnapshots(appId, tenantId);

  // Filter by month if year and month are provided
  if (year && month) {
    snapshots = snapshots.filter(s => {
      const d = new Date(s.time);
      return d.getFullYear() === year && d.getMonth() + 1 === month;
    });
  }

  res.json(snapshots);
}));

// Create a new backup for a specific tenant
router.post('/', asyncHandler(async (req, res) => {
  const { appId } = req.params;
  const { tenantId } = req.body;

  if (!tenantId || !isValidTenantId(tenantId)) {
    return res.status(400).json({ error: 'Valid tenantId is required' });
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

  if (!isValidSnapshotId(snapshotId)) {
    return res.status(400).json({ error: 'Invalid snapshot ID format' });
  }

  if (!tenantId || !isValidTenantId(tenantId)) {
    return res.status(400).json({ error: 'Valid tenantId is required' });
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

  if (!isValidSnapshotId(snapshotId)) {
    return res.status(400).json({ error: 'Invalid snapshot ID format' });
  }

  if (!tenantId || !domain || !isValidTenantId(tenantId)) {
    return res.status(400).json({ error: 'Valid tenantId and domain are required' });
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

  if (!isValidSnapshotId(snapshotId)) {
    return res.status(400).json({ error: 'Invalid snapshot ID format' });
  }

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
  const keepDaily = Math.max(0, Math.min(Number(req.body.keepDaily) || 7, 365));
  const keepWeekly = Math.max(0, Math.min(Number(req.body.keepWeekly) || 4, 52));
  const keepMonthly = Math.max(0, Math.min(Number(req.body.keepMonthly) || 12, 120));
  const result = await pruneBackups(appId, keepDaily, keepWeekly, keepMonthly);

  if (result.success) {
    res.json({ success: true, message: 'Old backups pruned' });
  } else {
    res.status(500).json({ error: result.error });
  }
}));

export default router;
