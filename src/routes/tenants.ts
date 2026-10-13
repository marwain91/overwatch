import { Router } from 'express';
import { listTenants, startTenant, stopTenant, restartTenant } from '../services/docker';
import { createTenant, deleteTenant, updateTenant, CreateTenantInput, validateImageTag } from '../services/tenant';
import { asyncHandler } from '../utils/asyncHandler';
import { isValidSlug } from '../utils/validators';
import { validateTenantId } from '../middleware/validators';
import { requireConfirmId } from '../middleware/confirmDestructive';
import { requireRole } from '../middleware/requireRole';
import { mintAdminAccess } from '../services/adminAccess';
import { getTenantTraefik, updateTenantTraefik } from '../services/traefikConfig';

const router = Router({ mergeParams: true });

// List tenants for an app
router.get('/', asyncHandler(async (req, res) => {
  const { appId } = (req.params as Record<string, string>);
  const allTenants = await listTenants();
  const appTenants = appId ? allTenants.filter(t => t.appId === appId) : allTenants;
  res.json(appTenants);
}));

// Create a new tenant — editor+
router.post('/', requireRole('editor'), asyncHandler(async (req, res) => {
  const { appId } = (req.params as Record<string, string>);
  const input: CreateTenantInput = {
    appId,
    tenantId: req.body.tenantId,
    domain: req.body.domain,
    imageTag: req.body.imageTag,
  };

  if (!input.tenantId || !input.domain) {
    return res.status(400).json({ error: 'tenantId and domain are required' });
  }

  // Validate tenantId from body (same rules as URL param)
  if (!isValidSlug(input.tenantId)) {
    return res.status(400).json({ error: 'Invalid tenant ID format' });
  }
  const tenant = await createTenant(input);
  res.status(201).json(tenant);
}));

// Update tenant version — editor+
router.patch('/:tenantId', validateTenantId, requireRole('editor'), asyncHandler(async (req, res) => {
  const { appId, tenantId } = (req.params as Record<string, string>);
  const { imageTag } = req.body;

  const tagValidation = validateImageTag(imageTag);
  if (!tagValidation.valid) {
    return res.status(400).json({ error: tagValidation.error });
  }

  await updateTenant(appId, tenantId, imageTag);
  res.json({ success: true, appId, tenantId, imageTag });
}));

// Delete a tenant. Requires admin role and X-Confirm-Id header matching tenantId.
router.delete('/:tenantId', validateTenantId, requireRole('admin'), requireConfirmId('tenantId'), asyncHandler(async (req, res) => {
  const { appId, tenantId } = (req.params as Record<string, string>);
  const keepData = req.query.keepData === 'true';

  await deleteTenant(appId, tenantId, keepData);
  res.json({ success: true, appId, tenantId });
}));

// Start tenant containers — editor+
router.post('/:tenantId/start', validateTenantId, requireRole('editor'), asyncHandler(async (req, res) => {
  const { appId, tenantId } = (req.params as Record<string, string>);
  await startTenant(appId, tenantId);
  res.json({ success: true, appId, tenantId });
}));

// Stop tenant containers — editor+
router.post('/:tenantId/stop', validateTenantId, requireRole('editor'), asyncHandler(async (req, res) => {
  const { appId, tenantId } = (req.params as Record<string, string>);
  await stopTenant(appId, tenantId);
  res.json({ success: true, appId, tenantId });
}));

// Restart tenant containers — editor+
router.post('/:tenantId/restart', validateTenantId, requireRole('editor'), asyncHandler(async (req, res) => {
  const { appId, tenantId } = (req.params as Record<string, string>);
  await restartTenant(appId, tenantId);
  res.json({ success: true, appId, tenantId });
}));

// Generate admin access token for a tenant — ADMIN ONLY. Mints a signed JWT
// that logs the bearer in as system-admin of the tenant app. Highest-privilege
// operation in the system; never expose to non-admin roles.
router.post('/:tenantId/access-token', validateTenantId, requireRole('admin'), asyncHandler(async (req, res) => {
  const { appId, tenantId } = (req.params as Record<string, string>);

  const { accessUrl, token: adminToken } = await mintAdminAccess(appId, tenantId);

  res.json({
    success: true,
    appId,
    tenantId,
    accessUrl,
    token: adminToken,
    expiresIn: '1 hour',
  });
}));

// Per-tenant Traefik overrides: cert resolver, host aliases, middleware overrides, raw labels.
router.get('/:tenantId/traefik', validateTenantId, asyncHandler(async (req, res) => {
  const { appId, tenantId } = (req.params as Record<string, string>);
  const t = await getTenantTraefik(appId, tenantId);
  res.json(t ?? null);
}));

router.put('/:tenantId/traefik', validateTenantId, requireRole('editor'), asyncHandler(async (req, res) => {
  const { appId, tenantId } = (req.params as Record<string, string>);
  const t = await updateTenantTraefik(appId, tenantId, req.body);
  res.json(t ?? null);
}));

export default router;
