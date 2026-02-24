import { Router } from 'express';
import { loadConfig } from '../config';
import { VERSION } from '../version';
import { listContainers, getContainerLogs, restartContainer, listTenants, extractContainerInfo } from '../services/docker';
import { getDatabaseAdapter } from '../adapters/database';
import { listApps } from '../services/app';
import { getBackupInfo, listSnapshots } from '../services/backup';
import { asyncHandler } from '../utils/asyncHandler';
import { isValidContainerId } from '../utils/validators';

const router = Router();

// Get all containers managed by Overwatch
router.get('/containers', asyncHandler(async (req, res) => {
  const containers = await listContainers();
  res.json(containers);
}));

// Get container logs
router.get('/containers/:containerId/logs', asyncHandler(async (req, res) => {
  const { containerId } = req.params;
  if (!isValidContainerId(containerId)) {
    return res.status(400).json({ error: 'Invalid container ID format' });
  }
  const tailParam = parseInt(req.query.tail as string, 10);
  const tail = Number.isInteger(tailParam) ? Math.max(1, Math.min(tailParam, 10000)) : 100;
  const logs = await getContainerLogs(containerId, tail);
  res.json({ logs });
}));

// Restart a container
router.post('/containers/:containerId/restart', asyncHandler(async (req, res) => {
  const { containerId } = req.params;
  if (!isValidContainerId(containerId)) {
    return res.status(400).json({ error: 'Invalid container ID format' });
  }
  await restartContainer(containerId);
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
    const info = extractContainerInfo(c.name);
    return !info || !initServices.has(info.service);
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
  const summaries: Record<string, { configured: boolean; initialized: boolean; schedule: string | null; lastBackup: string | null; totalSnapshots: number }> = {};

  for (const app of apps) {
    if (!app.backup?.enabled) {
      summaries[app.id] = { configured: false, initialized: false, schedule: null, lastBackup: null, totalSnapshots: 0 };
      continue;
    }

    const info = await getBackupInfo(app.id);
    let lastBackup: string | null = null;
    let totalSnapshots = 0;

    if (info.configured && info.initialized) {
      try {
        const snapshots = await listSnapshots(app.id);
        totalSnapshots = snapshots.length;
        if (snapshots.length > 0) {
          lastBackup = snapshots[0].time;
        }
      } catch {
        // Skip on error
      }
    }

    summaries[app.id] = {
      configured: info.configured,
      initialized: info.initialized,
      schedule: app.backup.schedule || null,
      lastBackup,
      totalSnapshots,
    };
  }

  res.json(summaries);
}));

// Get all tenants across all apps (global view)
router.get('/tenants', asyncHandler(async (req, res) => {
  const tenants = await listTenants();
  res.json(tenants);
}));

export default router;
