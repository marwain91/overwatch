import { Router, type RequestHandler } from 'express';
import {
  initializeRepository,
  unlockRepository,
  createBackup,
  backupAllTenants,
  restoreBackup,
  deleteSnapshot,
  pruneBackups,
  DEFAULT_RETENTION,
  type RetentionPolicy,
} from '../services/backup';
import { getBackupInfoCached, listSnapshotsCached } from '../services/backupCache';
import { getApp } from '../services/app';
import { createTenantFromBackup } from '../services/tenantFromBackup';
import { getTenantInfo } from '../services/docker';
import { asyncHandler } from '../utils/asyncHandler';
import { isValidSlug, isValidSnapshotId } from '../utils/validators';
import { requireRole } from '../middleware/requireRole';
import { requireConfirmId } from '../middleware/confirmDestructive';

const router = Router({ mergeParams: true });

// Get backup summary (status + latest snapshot info)
router.get('/summary', asyncHandler(async (req, res) => {
  const { appId } = (req.params as Record<string, string>);
  const app = await getApp(appId);
  if (!app) {
    return res.status(404).json({ error: 'App not found' });
  }

  const info = await getBackupInfoCached(appId);

  let lastBackup: string | null = null;
  let totalSnapshots = 0;

  if (info.configured && info.initialized) {
    const snapshots = await listSnapshotsCached(appId);
    totalSnapshots = snapshots.length;
    if (snapshots.length > 0) {
      lastBackup = snapshots[0].time; // already sorted desc
    }
  }

  // Resolve non-secret config values for display; a disabled backup block may
  // still carry stale settings that must not be shown as active.
  let bucket: string | null = null;
  let endpoint: string | null = null;
  const backup = app.backup?.enabled ? app.backup : undefined;
  if (backup?.s3?.bucket_env) {
    bucket = process.env[backup.s3.bucket_env] || null;
  }
  if (backup?.s3?.endpoint_env) {
    endpoint = process.env[backup.s3.endpoint_env] || null;
  }

  res.json({
    ...info,
    schedule: backup?.schedule || null,
    lastBackup,
    totalSnapshots,
    bucket,
    endpoint,
  });
}));

// Get backup configuration status for an app
router.get('/status', asyncHandler(async (req, res) => {
  const { appId } = (req.params as Record<string, string>);
  const info = await getBackupInfoCached(appId);
  res.json(info);
}));

// Initialize backup repository for an app — admin (touches encryption setup).
router.post('/init', requireRole('admin'), asyncHandler(async (req, res) => {
  const { appId } = (req.params as Record<string, string>);
  await initializeRepository(appId);
  res.json({ success: true, message: 'Repository initialized' });
}));

// Unlock repository — admin. Removes stale locks; `force: true` also removes
// live ones (break-glass: it breaks a backup or prune that is still running).
router.post('/unlock', requireRole('admin'), asyncHandler(async (req, res) => {
  const { appId } = (req.params as Record<string, string>);
  const force = req.body?.force === true;
  const result = await unlockRepository(appId, { force });
  if (result.success) {
    res.json({ success: true, message: 'Repository unlocked' });
  } else {
    res.status(500).json({ error: result.error });
  }
}));

// List backup snapshots for an app (optionally filtered by tenant and/or month)
router.get('/', asyncHandler(async (req, res) => {
  const { appId } = (req.params as Record<string, string>);
  const rawTenantId = Array.isArray(req.query.tenantId) ? req.query.tenantId[0] : req.query.tenantId;
  const tenantId = typeof rawTenantId === 'string' ? rawTenantId : undefined;

  if (tenantId && !isValidSlug(tenantId)) {
    return res.status(400).json({ error: 'Invalid tenant ID format' });
  }

  const rawYear = Array.isArray(req.query.year) ? req.query.year[0] : req.query.year;
  const rawMonth = Array.isArray(req.query.month) ? req.query.month[0] : req.query.month;
  const year = rawYear ? parseInt(rawYear as string, 10) : undefined;
  const month = rawMonth ? parseInt(rawMonth as string, 10) : undefined;

  let snapshots = await listSnapshotsCached(appId, tenantId);

  // Filter by month if valid year and month are provided
  if (Number.isInteger(year) && Number.isInteger(month) && month! >= 1 && month! <= 12) {
    snapshots = snapshots.filter(s => {
      const d = new Date(s.time);
      return d.getFullYear() === year && d.getMonth() + 1 === month;
    });
  }

  res.json(snapshots);
}));

// Create a new backup for a specific tenant — editor+
router.post('/', requireRole('editor'), asyncHandler(async (req, res) => {
  const { appId } = (req.params as Record<string, string>);
  const { tenantId } = req.body;

  if (!tenantId || !isValidSlug(tenantId)) {
    return res.status(400).json({ error: 'Valid tenantId is required' });
  }

  const result = await createBackup(appId, tenantId);

  if (result.success) {
    res.json({
      success: true,
      snapshotId: result.snapshotId,
      // Some service paths could not be copied: the snapshot is not a full backup.
      ...(result.incomplete ? { incomplete: true, missingPaths: result.missingPaths } : {}),
    });
  } else {
    res.status(result.busy ? 409 : 500).json({ error: result.error, isLocked: result.isLocked, lockInfo: result.lockInfo });
  }
}));

// Backup all tenants for an app — editor+
router.post('/all', requireRole('editor'), asyncHandler(async (req, res) => {
  const { appId } = (req.params as Record<string, string>);
  const result = await backupAllTenants(appId);
  res.json(result);
}));

/**
 * The restore target comes from the body, so requireConfirmId (which reads a
 * route param) cannot name it: same rule, same messages, for `tenantId`.
 */
const requireConfirmTargetTenant: RequestHandler = (req, res, next) => {
  const expected = typeof req.body?.tenantId === 'string' ? req.body.tenantId : '';
  if (!expected) return next(); // the handler rejects the missing tenantId
  const provided = req.header('X-Confirm-Id') || req.body?.confirmId;
  if (!provided) {
    return res.status(400).json({
      error: `Destructive operation requires X-Confirm-Id header (or confirmId body field) matching '${expected}'.`,
    });
  }
  if (provided !== expected) {
    return res.status(400).json({ error: `X-Confirm-Id mismatch: expected '${expected}', got '${provided}'.` });
  }
  next();
};

// Restore a backup into an existing tenant — admin + typed confirmation of the
// target tenant (its live data is replaced). The snapshot must be the tenant's
// own unless `allowCrossTenant: true`. A pre-restore snapshot is taken first.
router.post('/:snapshotId/restore', requireRole('admin'), requireConfirmTargetTenant, asyncHandler(async (req, res) => {
  const { appId, snapshotId } = (req.params as Record<string, string>);
  const { tenantId } = req.body;
  const allowCrossTenant = req.body?.allowCrossTenant === true;

  if (!isValidSnapshotId(snapshotId)) {
    return res.status(400).json({ error: 'Invalid snapshot ID format' });
  }

  if (!tenantId || !isValidSlug(tenantId)) {
    return res.status(400).json({ error: 'Valid tenantId is required' });
  }

  const tenant = await getTenantInfo(appId, tenantId);
  if (!tenant) {
    return res.status(404).json({ error: `Tenant ${tenantId} not found` });
  }

  const result = await restoreBackup(appId, snapshotId, tenantId, { allowCrossTenant });

  if (result.success) {
    res.json({
      success: true,
      message: `Backup restored to ${tenantId}`,
      safetySnapshotId: result.safetySnapshotId,
      ...(result.warnings?.length ? { warnings: result.warnings } : {}),
    });
  } else {
    res.status(500).json({
      error: result.error,
      isLocked: result.isLocked,
      lockInfo: result.lockInfo,
      ...(result.safetySnapshotId ? { safetySnapshotId: result.safetySnapshotId } : {}),
      ...(result.rolledBack !== undefined ? { rolledBack: result.rolledBack } : {}),
    });
  }
}));

// Create new tenant from backup — admin (creates resources, writes DB creds).
router.post('/:snapshotId/create-tenant', requireRole('admin'), asyncHandler(async (req, res) => {
  const { appId, snapshotId } = (req.params as Record<string, string>);
  const { tenantId, domain, imageTag } = req.body;

  if (!isValidSnapshotId(snapshotId)) {
    return res.status(400).json({ error: 'Invalid snapshot ID format' });
  }

  if (!tenantId || !domain || !isValidSlug(tenantId)) {
    return res.status(400).json({ error: 'Valid tenantId and domain are required' });
  }

  // createTenant falls back to the app's default_image_tag, then 'latest'.
  const result = await createTenantFromBackup(appId, snapshotId, { tenantId, domain, imageTag });

  if (result.success) {
    res.json({
      success: true,
      message: `New tenant ${tenantId} created from backup`,
      appId,
      tenantId,
      domain,
      ...(result.warnings?.length ? { warnings: result.warnings } : {}),
    });
  } else {
    res.status(500).json({ error: result.error, isLocked: result.isLocked, lockInfo: result.lockInfo });
  }
}));

// Delete a backup snapshot — admin + typed confirmation.
router.delete('/:snapshotId', requireRole('admin'), requireConfirmId('snapshotId'), asyncHandler(async (req, res) => {
  const { appId, snapshotId } = (req.params as Record<string, string>);

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

const RETENTION_MAX: RetentionPolicy = { keepDaily: 365, keepWeekly: 52, keepMonthly: 120 };

/** Omitted means the default; 0 is a real value (keep none of that kind). */
function parseRetentionPolicy(body: Record<string, unknown>): RetentionPolicy | string {
  const policy = { ...DEFAULT_RETENTION };
  for (const key of Object.keys(RETENTION_MAX) as Array<keyof RetentionPolicy>) {
    const raw = body[key];
    if (raw === undefined || raw === null) continue;
    const value = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > RETENTION_MAX[key]) {
      return `${key} must be an integer between 0 and ${RETENTION_MAX[key]}`;
    }
    policy[key] = value;
  }
  if (policy.keepDaily + policy.keepWeekly + policy.keepMonthly === 0) {
    return 'Refusing a retention policy that keeps no snapshots';
  }
  return policy;
}

// Prune old backups — admin (irreversibly drops snapshots). `dryRun: true`
// returns what the policy would forget without changing anything.
router.post('/prune', requireRole('admin'), asyncHandler(async (req, res) => {
  const { appId } = (req.params as Record<string, string>);
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const policy = parseRetentionPolicy(body);
  if (typeof policy === 'string') {
    return res.status(400).json({ error: policy });
  }
  const dryRun = body.dryRun === true;
  const result = await pruneBackups(appId, policy, { dryRun });

  if (!result.success) {
    res.status(500).json({ error: result.error });
  } else if (dryRun) {
    res.json({ ...result, policy });
  } else {
    res.json({ success: true, message: 'Old backups pruned', policy });
  }
}));

export default router;
