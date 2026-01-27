import { Router, Request, Response } from 'express';
import {
  listEnvVars,
  setEnvVar,
  deleteEnvVar,
  getEffectiveEnvVars,
  setTenantOverride,
  deleteTenantOverride,
  regenerateAllSharedEnvFiles,
  generateSharedEnvFile,
} from '../services/envVars';

const router = Router();

// List global env vars (sensitive values masked)
router.get('/', async (req: Request, res: Response) => {
  try {
    const vars = await listEnvVars();
    const masked = vars.map(v => ({
      ...v,
      value: v.sensitive ? '••••••••' : v.value,
    }));
    res.json(masked);
  } catch (error: any) {
    console.error('Error listing env vars:', error);
    res.status(500).json({ error: error.message || 'Failed to list environment variables' });
  }
});

// Create or update a global env var
router.post('/', async (req: Request, res: Response) => {
  try {
    const { key, value, sensitive, description } = req.body;

    if (!key) {
      return res.status(400).json({ error: 'Key is required' });
    }

    // When value is omitted, keep the existing value (for sensitive field edits)
    let effectiveValue: string;
    if (value === undefined || value === null || value === '') {
      const existing = (await listEnvVars()).find(v => v.key === key);
      if (existing) {
        effectiveValue = existing.value;
      } else {
        return res.status(400).json({ error: 'Value is required for new variables' });
      }
    } else {
      effectiveValue = String(value);
    }

    const envVar = await setEnvVar(key, effectiveValue, sensitive ?? false, description);
    const tenantsAffected = await regenerateAllSharedEnvFiles();

    res.json({
      envVar: {
        ...envVar,
        value: envVar.sensitive ? '••••••••' : envVar.value,
      },
      tenantsAffected,
    });
  } catch (error: any) {
    console.error('Error setting env var:', error);
    res.status(400).json({ error: error.message || 'Failed to set environment variable' });
  }
});

// Delete a global env var
router.delete('/:key', async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    await deleteEnvVar(key);
    const tenantsAffected = await regenerateAllSharedEnvFiles();
    res.json({ success: true, tenantsAffected });
  } catch (error: any) {
    console.error('Error deleting env var:', error);
    res.status(400).json({ error: error.message || 'Failed to delete environment variable' });
  }
});

// Get effective env vars for a tenant (merged view)
router.get('/tenants/:tenantId', async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;
    const effective = await getEffectiveEnvVars(tenantId);
    const masked = effective.map(v => ({
      ...v,
      value: v.sensitive ? '••••••••' : v.value,
    }));
    res.json(masked);
  } catch (error: any) {
    console.error('Error getting tenant env vars:', error);
    res.status(500).json({ error: error.message || 'Failed to get tenant environment variables' });
  }
});

// Set a tenant override
router.post('/tenants/:tenantId/overrides', async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;
    const { key, value, sensitive } = req.body;

    if (!key || value === undefined || value === null) {
      return res.status(400).json({ error: 'Key and value are required' });
    }

    await setTenantOverride(tenantId, key, String(value), sensitive ?? false);
    await generateSharedEnvFile(tenantId);

    res.json({ success: true });
  } catch (error: any) {
    console.error('Error setting tenant override:', error);
    res.status(400).json({ error: error.message || 'Failed to set tenant override' });
  }
});

// Delete a tenant override
router.delete('/tenants/:tenantId/overrides/:key', async (req: Request, res: Response) => {
  try {
    const { tenantId, key } = req.params;
    await deleteTenantOverride(tenantId, key);
    await generateSharedEnvFile(tenantId);

    res.json({ success: true });
  } catch (error: any) {
    console.error('Error deleting tenant override:', error);
    res.status(400).json({ error: error.message || 'Failed to delete tenant override' });
  }
});

export default router;
