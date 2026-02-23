import { Router } from 'express';
import { loadConfig, getContainerPrefix } from '../config';
import { listContainers, getContainerLogs, restartContainer, listTenants } from '../services/docker';
import { getDatabaseAdapter } from '../adapters/database';
import { listApps } from '../services/app';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

// Get all containers managed by Overwatch
router.get('/containers', asyncHandler(async (req, res) => {
  const containers = await listContainers();
  res.json(containers);
}));

// Get container logs
router.get('/containers/:containerId/logs', asyncHandler(async (req, res) => {
  const { containerId } = req.params;
  const tail = parseInt(req.query.tail as string) || 100;
  const logs = await getContainerLogs(containerId, tail);
  res.json({ logs });
}));

// Restart a container
router.post('/containers/:containerId/restart', asyncHandler(async (req, res) => {
  const { containerId } = req.params;
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

  const runningContainers = containers.filter(c => c.state === 'running');

  res.json({
    database: dbConnected ? 'connected' : 'disconnected',
    containers: containers.length,
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

// Get all tenants across all apps (global view)
router.get('/tenants', asyncHandler(async (req, res) => {
  const tenants = await listTenants();
  res.json(tenants);
}));

export default router;
