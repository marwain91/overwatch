import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { loadConfig } from '../config';
import { listTenants, startTenant, stopTenant, restartTenant, getTenantInfo } from '../services/docker';
import { createTenant, deleteTenant, updateTenant, CreateTenantInput } from '../services/tenant';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

// List all tenants
router.get('/', asyncHandler(async (req, res) => {
  const tenants = await listTenants();
  res.json(tenants);
}));

// Create a new tenant
router.post('/', asyncHandler(async (req, res) => {
  const input: CreateTenantInput = {
    tenantId: req.body.tenantId,
    domain: req.body.domain,
    imageTag: req.body.imageTag,
  };

  if (!input.tenantId || !input.domain) {
    return res.status(400).json({ error: 'tenantId and domain are required' });
  }

  const tenant = await createTenant(input);
  res.status(201).json(tenant);
}));

// Update tenant version
router.patch('/:tenantId', asyncHandler(async (req, res) => {
  const { tenantId } = req.params;
  const { imageTag } = req.body;

  if (!imageTag) {
    return res.status(400).json({ error: 'imageTag is required' });
  }

  await updateTenant(tenantId, imageTag);
  res.json({ success: true, tenantId, imageTag });
}));

// Delete a tenant
router.delete('/:tenantId', asyncHandler(async (req, res) => {
  const { tenantId } = req.params;
  const keepData = req.query.keepData === 'true';

  await deleteTenant(tenantId, keepData);
  res.json({ success: true, tenantId });
}));

// Start tenant containers
router.post('/:tenantId/start', asyncHandler(async (req, res) => {
  const { tenantId } = req.params;
  await startTenant(tenantId);
  res.json({ success: true, tenantId });
}));

// Stop tenant containers
router.post('/:tenantId/stop', asyncHandler(async (req, res) => {
  const { tenantId } = req.params;
  await stopTenant(tenantId);
  res.json({ success: true, tenantId });
}));

// Restart tenant containers
router.post('/:tenantId/restart', asyncHandler(async (req, res) => {
  const { tenantId } = req.params;
  await restartTenant(tenantId);
  res.json({ success: true, tenantId });
}));

// Generate admin access token for a tenant
router.post('/:tenantId/access-token', asyncHandler(async (req, res) => {
  const config = loadConfig();
  const adminAccess = config.admin_access;

  // Check if admin access is enabled
  if (!adminAccess?.enabled) {
    return res.status(400).json({ error: 'Admin access is not enabled in configuration' });
  }

  // Get the secret from the configured environment variable
  const secretEnv = adminAccess.secret_env || 'AUTH_SERVICE_SECRET';
  const secret = process.env[secretEnv];

  if (!secret) {
    return res.status(500).json({ error: `${secretEnv} not configured` });
  }

  const { tenantId } = req.params;

  // Get tenant info to build the URL
  const tenantInfo = await getTenantInfo(tenantId);
  if (!tenantInfo) {
    return res.status(404).json({ error: 'Tenant not found' });
  }

  // Build token payload from config
  const tokenPayload = adminAccess.token_payload;
  const adminFlag = tokenPayload?.admin_flag || 'isSystemAdmin';
  const emailTemplate = tokenPayload?.email_template || `admin@${config.project.name}.local`;
  const adminName = tokenPayload?.name || 'System Admin';

  // Generate admin access token
  const adminToken = jwt.sign(
    {
      [adminFlag]: true,
      tenantId,
      email: emailTemplate.replace('${tenantId}', tenantId),
      name: adminName,
      iat: Math.floor(Date.now() / 1000),
    },
    secret,
    { expiresIn: '1h' }
  );

  // Build the access URL from template
  const urlTemplate = adminAccess.url_template || 'https://${domain}/admin-login?token=${token}';
  const accessUrl = urlTemplate
    .replace('${domain}', tenantInfo.domain)
    .replace('${token}', adminToken)
    .replace('${tenantId}', tenantId);

  res.json({
    success: true,
    tenantId,
    accessUrl,
    expiresIn: '1 hour',
  });
}));

export default router;
