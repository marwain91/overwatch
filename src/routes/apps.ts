import { Router } from 'express';
import { listApps, getApp, createApp, updateApp, deleteApp, listTrashedApps, restoreApp, purgeApp } from '../services/app';
import { getImageTagsForApp } from '../adapters/registry';
import { CreateAppSchema } from '../models/app';
import { asyncHandler } from '../utils/asyncHandler';
import { validateAppId } from '../middleware/validators';
import { requireConfirmId } from '../middleware/confirmDestructive';
import { requireRole } from '../middleware/requireRole';
import { getCurrentUserEmail } from '../utils/jwt';

const router = Router();

// List all apps
router.get('/', asyncHandler(async (req, res) => {
  const apps = await listApps();
  res.json(apps);
}));

// Create a new app
router.post('/', asyncHandler(async (req, res) => {
  const parseResult = CreateAppSchema.safeParse(req.body);
  if (!parseResult.success) {
    const errors = parseResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
    return res.status(400).json({ error: `Invalid app definition: ${errors}` });
  }

  const app = await createApp(parseResult.data);
  res.status(201).json(app);
}));

// Get app details
router.get('/:appId', validateAppId, asyncHandler(async (req, res) => {
  const app = await getApp(req.params.appId);
  if (!app) {
    return res.status(404).json({ error: 'App not found' });
  }
  res.json(app);
}));

// Update app config
router.put('/:appId', validateAppId, asyncHandler(async (req, res) => {
  const app = await updateApp({ ...req.body, id: req.params.appId });
  res.json(app);
}));

// List trashed (soft-deleted) apps.
// Note: placed before the :appId sub-routes so it doesn't get shadowed.
router.get('/.trashed', asyncHandler(async (_req, res) => {
  const trashed = await listTrashedApps();
  res.json(trashed);
}));

// Restore a soft-deleted app.
router.post('/:appId/restore', validateAppId, requireRole('admin'), asyncHandler(async (req, res) => {
  const app = await restoreApp(req.params.appId);
  res.json({ success: true, app });
}));

// Permanently purge a soft-deleted app from the trash.
router.delete('/:appId/purge', validateAppId, requireRole('admin'), requireConfirmId('appId'), asyncHandler(async (req, res) => {
  await purgeApp(req.params.appId);
  res.json({ success: true });
}));

// Delete app. force=true with active tenants now soft-deletes (moves to trash)
// instead of dropping the record. Requires X-Confirm-Id header matching appId.
router.delete('/:appId', validateAppId, requireRole('admin'), requireConfirmId('appId'), asyncHandler(async (req, res) => {
  const force = req.query.force === 'true';
  const actor = getCurrentUserEmail(req) || 'unknown';
  await deleteApp(req.params.appId, force, actor);
  res.json({ success: true });
}));

// Get available image tags for an app
router.get('/:appId/tags', validateAppId, asyncHandler(async (req, res) => {
  const app = await getApp(req.params.appId);
  if (!app) {
    return res.status(404).json({ error: 'App not found' });
  }
  const tags = await getImageTagsForApp(app);
  res.json({ tags });
}));

// Test registry connection for an app
router.post('/:appId/registry/test', validateAppId, asyncHandler(async (req, res) => {
  const app = await getApp(req.params.appId);
  if (!app) {
    return res.status(404).json({ error: 'App not found' });
  }
  try {
    const tags = await getImageTagsForApp(app);
    res.json({ success: true, tagsFound: tags.length });
  } catch (error: any) {
    console.error(`Registry test failed for app ${app.id}:`, error.message);
    res.status(500).json({ success: false, error: 'Registry connection failed. Check credentials and configuration.' });
  }
}));

export default router;
