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

const router = Router();

// List global env vars (sensitive values masked)
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const vars = await listEnvVars();
  const masked = vars.map(v => ({
    ...v,
    value: v.sensitive ? '••••••••' : v.value,
  }));
  res.json(masked);
}));

// Create or update a global env var
router.post('/', asyncHandler(async (req: Request, res: Response) => {
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
}));

// Delete a global env var
router.delete('/:key', asyncHandler(async (req: Request, res: Response) => {
  const { key } = req.params;
  await deleteEnvVar(key);
  const tenantsAffected = await regenerateAllSharedEnvFiles();
  res.json({ success: true, tenantsAffected });
}));

// Get effective env vars for a tenant (merged view)
router.get('/tenants/:tenantId', asyncHandler(async (req: Request, res: Response) => {
  const { tenantId } = req.params;
  const effective = await getEffectiveEnvVars(tenantId);
  const masked = effective.map(v => ({
    ...v,
    value: v.sensitive ? '••••••••' : v.value,
  }));
  res.json(masked);
}));

// Set a tenant override
router.post('/tenants/:tenantId/overrides', asyncHandler(async (req: Request, res: Response) => {
  const { tenantId } = req.params;
  const { key, value, sensitive } = req.body;

  if (!key || value === undefined || value === null) {
    return res.status(400).json({ error: 'Key and value are required' });
  }

  await setTenantOverride(tenantId, key, String(value), sensitive ?? false);
  await generateSharedEnvFile(tenantId);

  res.json({ success: true });
}));

// Delete a tenant override
router.delete('/tenants/:tenantId/overrides/:key', asyncHandler(async (req: Request, res: Response) => {
  const { tenantId, key } = req.params;
  await deleteTenantOverride(tenantId, key);
  await generateSharedEnvFile(tenantId);

  res.json({ success: true });
}));

export default router;
