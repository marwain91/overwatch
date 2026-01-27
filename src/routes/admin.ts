import { Router, Request, Response } from 'express';
import Docker from 'dockerode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { loadConfig, getContainerPrefix } from '../config';

const router = Router();
const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const execAsync = promisify(exec);

// Configuration - all configurable via environment variables
const OVERWATCH_IMAGE = process.env.OVERWATCH_IMAGE || 'ghcr.io/marwain91/overwatch:latest';
const COMPOSE_DIR = process.env.COMPOSE_DIR || '/opt/overwatch/infrastructure';
const SERVICE_NAME = process.env.SERVICE_NAME || 'overwatch';

// Get current Overwatch version/image info
router.get('/version', async (req: Request, res: Response) => {
  try {
    // Use config prefix to find the admin container
    const prefix = getContainerPrefix();
    const containers = await docker.listContainers({
      filters: { name: [`${prefix}-admin`, `${prefix}-overwatch`, 'overwatch'] }
    });

    const currentContainer = containers.find(c =>
      c.Names.some(n => n.includes('admin') || n.includes('overwatch'))
    );

    if (currentContainer) {
      res.json({
        image: currentContainer.Image,
        imageId: currentContainer.ImageID,
        created: currentContainer.Created,
        status: currentContainer.Status,
      });
    } else {
      res.json({
        image: OVERWATCH_IMAGE,
        message: 'Could not detect current container'
      });
    }
  } catch (error: any) {
    console.error('Error getting version info:', error);
    res.status(500).json({ error: error.message || 'Failed to get version info' });
  }
});

// Check for updates
router.get('/check-update', async (req: Request, res: Response) => {
  try {
    // Get current image digest
    let currentDigest = null;
    try {
      const { stdout } = await execAsync(`docker inspect --format='{{index .RepoDigests 0}}' ${OVERWATCH_IMAGE}`);
      currentDigest = stdout.trim();
    } catch {
      // Image might not exist locally yet
    }

    // Pull latest image
    console.log(`Pulling ${OVERWATCH_IMAGE} to check for updates...`);
    await execAsync(`docker pull ${OVERWATCH_IMAGE}`);

    // Get new image digest
    const { stdout: newDigest } = await execAsync(`docker inspect --format='{{index .RepoDigests 0}}' ${OVERWATCH_IMAGE}`);

    const updateAvailable = currentDigest !== newDigest.trim();

    res.json({
      currentDigest,
      latestDigest: newDigest.trim(),
      updateAvailable,
      image: OVERWATCH_IMAGE,
    });
  } catch (error: any) {
    console.error('Error checking for updates:', error);
    res.status(500).json({ error: error.message || 'Failed to check for updates' });
  }
});

// Trigger self-update
router.post('/update', async (req: Request, res: Response) => {
  try {
    console.log(`Updating Overwatch: ${OVERWATCH_IMAGE}`);

    // Pull the latest image
    console.log('Pulling latest image...');
    await execAsync(`docker pull ${OVERWATCH_IMAGE}`);
    console.log('Pull complete');

    // Send response before restarting (client will lose connection)
    res.json({
      success: true,
      message: 'Update pulled successfully. Container will restart momentarily.',
    });

    // Give the response time to be sent, then restart using docker compose
    setTimeout(async () => {
      try {
        console.log(`Restarting via docker compose in ${COMPOSE_DIR}...`);
        exec(`cd ${COMPOSE_DIR} && docker compose up -d --force-recreate ${SERVICE_NAME}`, (error, stdout, stderr) => {
          if (error) {
            console.error('Restart error:', error);
            console.error('stderr:', stderr);
          } else {
            console.log('Container restart initiated:', stdout);
          }
        });
      } catch (err) {
        console.error('Error during restart:', err);
      }
    }, 500);

  } catch (error: any) {
    console.error('Error updating Overwatch:', error);
    res.status(500).json({ error: error.message || 'Failed to update Overwatch' });
  }
});

export default router;
