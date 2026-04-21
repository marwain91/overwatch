import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { listTenants, startTenant, stopTenant, restartTenant, getTenantInfo } from '../services/docker';
import { createTenant, deleteTenant, updateTenant, CreateTenantInput } from '../services/tenant';
import { getApp } from '../services/app';
import { asyncHandler } from '../utils/asyncHandler';
import { isValidSlug } from '../utils/validators';
import { validateTenantId } from '../middleware/validators';
import { requireConfirmId } from '../middleware/confirmDestructive';
import { requireRole } from '../middleware/requireRole';

const router = Router({ mergeParams: true });

// List tenants for an app
router.get('/', asyncHandler(async (req, res) => {
  const { appId } = req.params;
  const allTenants = await listTenants();
  const appTenants = appId ? allTenants.filter(t => t.appId === appId) : allTenants;
  res.json(appTenants);
}));

// Create a new tenant — editor+
router.post('/', requireRole('editor'), asyncHandler(async (req, res) => {
  const { appId } = req.params;
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
  const { appId, tenantId } = req.params;
  const { imageTag } = req.body;

  if (!imageTag) {
    return res.status(400).json({ error: 'imageTag is required' });
  }

  await updateTenant(appId, tenantId, imageTag);
  res.json({ success: true, appId, tenantId, imageTag });
}));

// Delete a tenant. Requires admin role and X-Confirm-Id header matching tenantId.
router.delete('/:tenantId', validateTenantId, requireRole('admin'), requireConfirmId('tenantId'), asyncHandler(async (req, res) => {
  const { appId, tenantId } = req.params;
  const keepData = req.query.keepData === 'true';

  await deleteTenant(appId, tenantId, keepData);
  res.json({ success: true, appId, tenantId });
}));

// Start tenant containers — editor+
router.post('/:tenantId/start', validateTenantId, requireRole('editor'), asyncHandler(async (req, res) => {
  const { appId, tenantId } = req.params;
  await startTenant(appId, tenantId);
  res.json({ success: true, appId, tenantId });
}));

// Stop tenant containers — editor+
router.post('/:tenantId/stop', validateTenantId, requireRole('editor'), asyncHandler(async (req, res) => {
  const { appId, tenantId } = req.params;
  await stopTenant(appId, tenantId);
  res.json({ success: true, appId, tenantId });
}));

// Restart tenant containers — editor+
router.post('/:tenantId/restart', validateTenantId, requireRole('editor'), asyncHandler(async (req, res) => {
  const { appId, tenantId } = req.params;
  await restartTenant(appId, tenantId);
  res.json({ success: true, appId, tenantId });
}));

// Generate admin access token for a tenant — ADMIN ONLY. Mints a signed JWT
// that logs the bearer in as system-admin of the tenant app. Highest-privilege
// operation in the system; never expose to non-admin roles.
router.post('/:tenantId/access-token', validateTenantId, requireRole('admin'), asyncHandler(async (req, res) => {
  const { appId, tenantId } = req.params;

  const app = await getApp(appId);
  if (!app) {
    return res.status(404).json({ error: 'App not found' });
  }

  const adminAccess = app.admin_access;
  if (!adminAccess?.enabled) {
    return res.status(400).json({ error: 'Admin access is not enabled for this app' });
  }

  const secretEnv = adminAccess.secret_env || 'AUTH_SERVICE_SECRET';
  const secret = process.env[secretEnv];

  if (!secret) {
    console.error(`[AdminAccess] Secret env '${secretEnv}' not configured for app ${appId}`);
    return res.status(500).json({ error: 'Admin access is not properly configured. Contact your administrator.' });
  }

  const tenantInfo = await getTenantInfo(appId, tenantId);
  if (!tenantInfo) {
    return res.status(404).json({ error: 'Tenant not found' });
  }

  const tokenPayload = adminAccess.token_payload;
  const adminFlag = tokenPayload?.admin_flag || 'isSystemAdmin';
  const emailTemplate = tokenPayload?.email_template || `admin@${app.name}.local`;
  const adminName = tokenPayload?.name || 'System Admin';

  const adminToken = jwt.sign(
    {
      [adminFlag]: true,
      appId,
      tenantId,
      email: emailTemplate.replace('${tenantId}', tenantId),
      name: adminName,
      iat: Math.floor(Date.now() / 1000),
    },
    secret,
    { expiresIn: '1h' }
  );

  const urlTemplate = adminAccess.url_template || 'https://${domain}/admin-login#token=${token}';
  // Defence in depth: re-validate the pinned prefix at token-mint time. The schema
  // enforces it at write, but this catches any template reaching the mint path
  // that somehow bypassed schema validation (e.g. hand-edited apps.json).
  if (!/^https:\/\/\$\{domain\}/.test(urlTemplate)) {
    console.error(`[AdminAccess] url_template rejected at runtime for ${appId}: ${urlTemplate}`);
    return res.status(500).json({ error: 'Admin access URL template is invalid; contact administrator.' });
  }
  const accessUrl = urlTemplate
    .replace('${domain}', encodeURIComponent(tenantInfo.domain))
    .replace('${token}', encodeURIComponent(adminToken))
    .replace('${tenantId}', encodeURIComponent(tenantId));

  res.json({
    success: true,
    appId,
    tenantId,
    accessUrl,
    token: adminToken,
    expiresIn: '1 hour',
  });
}));

export default router;
