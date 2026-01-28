import { Router } from 'express';
import { loadConfig, getContainerPrefix } from '../config';
import { listContainers, getContainerLogs, restartContainer } from '../services/docker';
import { getDatabaseAdapter } from '../adapters/database';
import { getImageTags } from '../adapters/registry';

const router = Router();

// Get all containers managed by Overwatch
router.get('/containers', async (req, res) => {
  try {
    const containers = await listContainers();
    res.json(containers);
  } catch (error) {
    console.error('Error listing containers:', error);
    res.status(500).json({ error: 'Failed to list containers' });
  }
});

// Get container logs
router.get('/containers/:containerId/logs', async (req, res) => {
  try {
    const { containerId } = req.params;
    const tail = parseInt(req.query.tail as string) || 100;
    const logs = await getContainerLogs(containerId, tail);
    res.json({ logs });
  } catch (error) {
    console.error('Error getting logs:', error);
    res.status(500).json({ error: 'Failed to get container logs' });
  }
});

// Restart a container
router.post('/containers/:containerId/restart', async (req, res) => {
  try {
    const { containerId } = req.params;
    await restartContainer(containerId);
    res.json({ success: true });
  } catch (error) {
    console.error('Error restarting container:', error);
    res.status(500).json({ error: 'Failed to restart container' });
  }
});

// Get system health
router.get('/health', async (req, res) => {
  try {
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
  } catch (error) {
    console.error('Error getting health:', error);
    res.status(500).json({ error: 'Failed to get health status' });
  }
});

// Get available image tags
router.get('/tags', async (req, res) => {
  try {
    const tags = await getImageTags();
    res.json({ tags });
  } catch (error) {
    console.error('Error fetching tags:', error);
    res.status(500).json({ error: 'Failed to fetch image tags' });
  }
});

// Get project configuration (for frontend)
router.get('/config', async (req, res) => {
  try {
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
  } catch (error) {
    console.error('Error getting config:', error);
    res.status(500).json({ error: 'Failed to get configuration' });
  }
});

export default router;
