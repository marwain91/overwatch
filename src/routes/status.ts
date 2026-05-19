import { Router } from 'express';
import { loadConfig } from '../config';
import { VERSION } from '../version';
import { listContainers, getContainerLogs, restartContainer, listTenants } from '../services/docker';
import { getDatabaseAdapter } from '../adapters/database';
import { listApps } from '../services/app';
import { getBackupInfoCached, listSnapshotsCached } from '../services/backupCache';
import { asyncHandler } from '../utils/asyncHandler';
import { isValidContainerId } from '../utils/validators';
import { requireRole } from '../middleware/requireRole';

const router = Router();

function containerIdMatches(requested: string, managedId: string): boolean {
  return requested === managedId || requested.startsWith(managedId) || managedId.startsWith(requested);
}

async function findManagedContainerId(containerId: string): Promise<string | null> {
  const containers = await listContainers();
  const managed = containers.find(c => containerIdMatches(containerId, c.id));
  return managed?.id ?? null;
}

// Get all containers managed by Overwatch
router.get('/containers', asyncHandler(async (req, res) => {
  const containers = await listContainers();
  res.json(containers);
}));

// Get container logs
router.get('/containers/:containerId/logs', asyncHandler(async (req, res) => {
  const { containerId } = (req.params as Record<string, string>);
  if (!isValidContainerId(containerId)) {
    return res.status(400).json({ error: 'Invalid container ID format' });
  }
  const tailParam = parseInt(req.query.tail as string, 10);
  const tail = Number.isInteger(tailParam) ? Math.max(1, Math.min(tailParam, 10000)) : 100;
  const managedId = await findManagedContainerId(containerId);
  if (!managedId) {
    return res.status(404).json({ error: 'Container not found' });
  }
  const logs = await getContainerLogs(managedId, tail);
  res.json({ logs });
}));

// Restart a container — admin-only (operational impact; can mask outages).
router.post('/containers/:containerId/restart', requireRole('admin'), asyncHandler(async (req, res) => {
  const { containerId } = (req.params as Record<string, string>);
  if (!isValidContainerId(containerId)) {
    return res.status(400).json({ error: 'Invalid container ID format' });
  }
  const managedId = await findManagedContainerId(containerId);
  if (!managedId) {
    return res.status(404).json({ error: 'Container not found' });
  }
  await restartContainer(managedId);
  res.json({ success: true });
}));

// Get system health
router.get('/health', asyncHandler(async (req, res) => {
  const config = loadConfig();
  const db = getDatabaseAdapter();

  const dbConnected = await db.testConnection();
  const containers = await listContainers();
  const databases = await db.listDatabases();
  const apps = await listApps();

  // Build set of init container service names to exclude from counts
  const initServices = new Set<string>();
  for (const app of apps) {
    for (const svc of app.services) {
      if (svc.is_init_container) initServices.add(svc.name);
    }
  }

  const nonInitContainers = containers.filter(c => {
    return !c.service || !initServices.has(c.service);
  });
  const runningContainers = nonInitContainers.filter(c => c.state === 'running');

  res.json({
    database: dbConnected ? 'connected' : 'disconnected',
    containers: nonInitContainers.length,
    runningContainers: runningContainers.length,
    databases: databases.length,
    apps: apps.length,
    containerDetails: containers.map(c => ({
      name: c.name,
      state: c.state,
      status: c.status,
      appId: c.appId,
    })),
  });
}));

// Get project configuration (for frontend)
router.get('/config', asyncHandler(async (req, res) => {
  const config = loadConfig();
  const apps = await listApps();
  res.json({
    version: VERSION,
    project: {
      name: config.project.name,
      prefix: config.project.prefix,
    },
    apps: apps.map(a => ({
      id: a.id,
      name: a.name,
      servicesCount: a.services.length,
      registry: { type: a.registry.type },
      backup: { enabled: a.backup?.enabled ?? false },
    })),
    database: {
      type: config.database.type,
    },
  });
}));

// Get backup summaries for all apps
router.get('/backup-summaries', asyncHandler(async (req, res) => {
  const apps = await listApps();

  const entries = await Promise.all(apps.map(async (app) => {
    if (!app.backup?.enabled) {
      return [app.id, { configured: false, initialized: false, schedule: null, lastBackup: null, totalSnapshots: 0 }] as const;
    }

    const info = await getBackupInfoCached(app.id);
    let lastBackup: string | null = null;
    let totalSnapshots = 0;

    if (info.configured && info.initialized) {
      try {
        const snapshots = await listSnapshotsCached(app.id);
        totalSnapshots = snapshots.length;
        if (snapshots.length > 0) {
          lastBackup = snapshots[0].time;
        }
      } catch {
        // Skip on error
      }
    }

    return [app.id, {
      configured: info.configured,
      initialized: info.initialized,
      schedule: app.backup.schedule || null,
      lastBackup,
      totalSnapshots,
    }] as const;
  }));

  res.json(Object.fromEntries(entries));
}));

// Get all tenants across all apps (global view)
router.get('/tenants', asyncHandler(async (req, res) => {
  const tenants = await listTenants();
  res.json(tenants);
}));

export default router;
