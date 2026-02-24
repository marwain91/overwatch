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
import { asyncHandler } from '../utils/asyncHandler';
import { validateTenantId } from '../middleware/validators';

const router = Router({ mergeParams: true });

// List global env vars for an app (sensitive values masked)
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const { appId } = req.params;
  const vars = await listEnvVars(appId);
  const masked = vars.map(v => ({
    ...v,
    value: v.sensitive ? '••••••••' : v.value,
  }));
  res.json(masked);
}));

// Create or update a global env var for an app
router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const { appId } = req.params;
  const { key, value, sensitive, description } = req.body;

  if (!key) {
    return res.status(400).json({ error: 'Key is required' });
  }

  // When value is omitted, keep the existing value (for sensitive field edits)
  let effectiveValue: string;
  if (value === undefined || value === null || value === '') {
    const existing = (await listEnvVars(appId)).find(v => v.key === key);
    if (existing) {
      effectiveValue = existing.value;
    } else {
      return res.status(400).json({ error: 'Value is required for new variables' });
    }
  } else {
    effectiveValue = String(value);
  }

  const envVar = await setEnvVar(appId, key, effectiveValue, sensitive ?? false, description);
  const tenantsAffected = await regenerateAllSharedEnvFiles();

  res.json({
    envVar: {
      ...envVar,
      value: envVar.sensitive ? '••••••••' : envVar.value,
    },
    tenantsAffected,
  });
}));

// Delete a global env var for an app
router.delete('/:key', asyncHandler(async (req: Request, res: Response) => {
  const { appId, key } = req.params;
  await deleteEnvVar(appId, key);
  const tenantsAffected = await regenerateAllSharedEnvFiles();
  res.json({ success: true, tenantsAffected });
}));

// Get effective env vars for a tenant (merged view)
router.get('/tenants/:tenantId', validateTenantId, asyncHandler(async (req: Request, res: Response) => {
  const { appId, tenantId } = req.params;
  const effective = await getEffectiveEnvVars(appId, tenantId);
  const masked = effective.map(v => ({
    ...v,
    value: v.sensitive ? '••••••••' : v.value,
  }));
  res.json(masked);
}));

// Set a tenant override
router.post('/tenants/:tenantId/overrides', validateTenantId, asyncHandler(async (req: Request, res: Response) => {
  const { appId, tenantId } = req.params;
  const { key, value, sensitive } = req.body;

  if (!key || value === undefined || value === null) {
    return res.status(400).json({ error: 'Key and value are required' });
  }

  await setTenantOverride(appId, tenantId, key, String(value), sensitive ?? false);
  await generateSharedEnvFile(appId, tenantId);

  res.json({ success: true });
}));

// Delete a tenant override
router.delete('/tenants/:tenantId/overrides/:key', validateTenantId, asyncHandler(async (req: Request, res: Response) => {
  const { appId, tenantId, key } = req.params;
  await deleteTenantOverride(appId, tenantId, key);
  await generateSharedEnvFile(appId, tenantId);

  res.json({ success: true });
}));

export default router;
