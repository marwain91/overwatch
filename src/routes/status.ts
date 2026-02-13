import { Router } from 'express';
import { loadConfig, getContainerPrefix } from '../config';
import { listContainers, getContainerLogs, restartContainer } from '../services/docker';
import { getDatabaseAdapter } from '../adapters/database';
import { getImageTags } from '../adapters/registry';
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
  const prefix = getContainerPrefix();
  const db = getDatabaseAdapter();

  const dbConnected = await db.testConnection();
  const containers = await listContainers();
  const databases = await db.listDatabases();

  // Exclude init containers (like migrators) from running count
  const initServices = config.services
    .filter(s => s.is_init_container)
    .map(s => s.name);

  const nonInitContainers = containers.filter(c => {
    const parts = c.name.split('-');
    const serviceName = parts[parts.length - 1];
    return !initServices.includes(serviceName);
  });

  const runningContainers = nonInitContainers.filter(c => c.state === 'running');

  res.json({
    database: dbConnected ? 'connected' : 'disconnected',
    containers: nonInitContainers.length,
    runningContainers: runningContainers.length,
    databases: databases.length,
    // Include container details for tooltip
    containerDetails: containers.map(c => ({
      name: c.name.replace(`${prefix}-`, ''),
      state: c.state,
      status: c.status,
    })),
  });
}));

// Get available image tags
router.get('/tags', asyncHandler(async (req, res) => {
  const tags = await getImageTags();
  res.json({ tags });
}));

// Get project configuration (for frontend)
router.get('/config', asyncHandler(async (req, res) => {
  const config = loadConfig();
  res.json({
    project: {
      name: config.project.name,
      prefix: config.project.prefix,
    },
    services: config.services.map(s => ({
      name: s.name,
      required: s.required,
      isInitContainer: s.is_init_container,
    })),
    registry: {
      type: config.registry.type,
    },
    database: {
      type: config.database.type,
    },
    backup: {
      enabled: config.backup?.enabled ?? false,
    },
  });
}));

export default router;
