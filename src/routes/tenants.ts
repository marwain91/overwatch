import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { loadConfig } from '../config';
import { listTenants, startTenant, stopTenant, restartTenant, getTenantInfo } from '../services/docker';
import { createTenant, deleteTenant, updateTenant, CreateTenantInput } from '../services/tenant';

const router = Router();

// List all tenants
router.get('/', async (req, res) => {
  try {
    const tenants = await listTenants();
    res.json(tenants);
  } catch (error) {
    console.error('Error listing tenants:', error);
    res.status(500).json({ error: 'Failed to list tenants' });
  }
});

// Create a new tenant
router.post('/', async (req, res) => {
  try {
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
  } catch (error: any) {
    console.error('Error creating tenant:', error);
    res.status(400).json({ error: error.message || 'Failed to create tenant' });
  }
});

// Update tenant version
router.patch('/:tenantId', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { imageTag } = req.body;

    if (!imageTag) {
      return res.status(400).json({ error: 'imageTag is required' });
    }

    await updateTenant(tenantId, imageTag);
    res.json({ success: true, tenantId, imageTag });
  } catch (error: any) {
    console.error('Error updating tenant:', error);
    res.status(400).json({ error: error.message || 'Failed to update tenant' });
  }
});

// Delete a tenant
router.delete('/:tenantId', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const keepData = req.query.keepData === 'true';

    await deleteTenant(tenantId, keepData);
    res.json({ success: true, tenantId });
  } catch (error: any) {
    console.error('Error deleting tenant:', error);
    res.status(400).json({ error: error.message || 'Failed to delete tenant' });
  }
});

// Start tenant containers
router.post('/:tenantId/start', async (req, res) => {
  try {
    const { tenantId } = req.params;
    await startTenant(tenantId);
    res.json({ success: true, tenantId });
  } catch (error: any) {
    console.error('Error starting tenant:', error);
    res.status(400).json({ error: error.message || 'Failed to start tenant' });
  }
});

// Stop tenant containers
router.post('/:tenantId/stop', async (req, res) => {
  try {
    const { tenantId } = req.params;
    await stopTenant(tenantId);
    res.json({ success: true, tenantId });
  } catch (error: any) {
    console.error('Error stopping tenant:', error);
    res.status(400).json({ error: error.message || 'Failed to stop tenant' });
  }
});

// Restart tenant containers
router.post('/:tenantId/restart', async (req, res) => {
  try {
    const { tenantId } = req.params;
    await restartTenant(tenantId);
    res.json({ success: true, tenantId });
  } catch (error: any) {
    console.error('Error restarting tenant:', error);
    res.status(400).json({ error: error.message || 'Failed to restart tenant' });
  }
});

// Generate admin access token for a tenant
router.post('/:tenantId/access-token', async (req, res) => {
  try {
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
    const tokenPayload = adminAccess.token_payload || {};
    const adminFlag = tokenPayload.admin_flag || 'isSystemAdmin';
    const emailTemplate = tokenPayload.email_template || `admin@${config.project.name}.local`;
    const adminName = tokenPayload.name || 'System Admin';

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
  } catch (error: any) {
    console.error('Error generating access token:', error);
    res.status(500).json({ error: error.message || 'Failed to generate access token' });
  }
});

export default router;
