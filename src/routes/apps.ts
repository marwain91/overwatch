import { Router } from 'express';
import { listApps, getApp, createApp, updateApp, deleteApp, listTrashedApps, restoreApp, purgeApp } from '../services/app';
import { getImageTagsForApp } from '../adapters/registry';
import { CreateAppSchema } from '../models/app';
import { asyncHandler } from '../utils/asyncHandler';
import { validateAppId } from '../middleware/validators';
import { requireConfirmId } from '../middleware/confirmDestructive';
import { requireRole } from '../middleware/requireRole';
import { getCurrentUserEmail } from '../utils/jwt';
import { getAppTraefik, updateAppTraefik } from '../services/traefikConfig';

const router = Router();

// List all apps
router.get('/', asyncHandler(async (req, res) => {
  const apps = await listApps();
  res.json(apps);
}));

// Create a new app. Admin-only because the payload includes registry credentials
// and optional admin_access / backup configs.
router.post('/', requireRole('admin'), asyncHandler(async (req, res) => {
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

// Update app config. Admin-only — update payload can change registry creds,
// admin_access (token-mint URL template), and backup targets.
router.put('/:appId', validateAppId, requireRole('admin'), asyncHandler(async (req, res) => {
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

// Get available image tags for an app.
// Failures from the upstream registry (missing scope, 4xx/5xx, network) are
// returned as 200 with `{ tags: [], error }` so the UI can show the reason
// inline without a noisy 500 in the browser console — listing tags is a
// best-effort convenience, not a hard dependency.
router.get('/:appId/tags', validateAppId, asyncHandler(async (req, res) => {
  const app = await getApp(req.params.appId);
  if (!app) {
    return res.status(404).json({ error: 'App not found' });
  }
  try {
    const tags = await getImageTagsForApp(app);
    res.json({ tags });
  } catch (error: any) {
    console.error(`Tag listing failed for app ${app.id}:`, error?.message || error);
    res.json({ tags: [], error: error?.message || 'Failed to list tags from registry' });
  }
}));

// Test registry connection for an app — editor+ (reads non-secret status).
router.post('/:appId/registry/test', validateAppId, requireRole('editor'), asyncHandler(async (req, res) => {
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

// App-scoped Traefik config — middleware library + default_middlewares.
// Editor+ matches the rest of the app/tenant editing surface.
router.get('/:appId/traefik', validateAppId, asyncHandler(async (req, res) => {
  const t = await getAppTraefik(req.params.appId);
  res.json(t ?? null);
}));

router.put('/:appId/traefik', validateAppId, requireRole('editor'), asyncHandler(async (req, res) => {
  const t = await updateAppTraefik(req.params.appId, req.body);
  res.json(t);
}));

export default router;
