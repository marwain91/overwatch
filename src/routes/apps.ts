import { Router } from 'express';
import { listApps, getApp, createApp, updateApp, deleteApp } from '../services/app';
import { getImageTagsForApp } from '../adapters/registry';
import { CreateAppSchema } from '../models/app';
import { asyncHandler } from '../utils/asyncHandler';

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
router.get('/:appId', asyncHandler(async (req, res) => {
  const app = await getApp(req.params.appId);
  if (!app) {
    return res.status(404).json({ error: 'App not found' });
  }
  res.json(app);
}));

// Update app config
router.put('/:appId', asyncHandler(async (req, res) => {
  const app = await updateApp({ ...req.body, id: req.params.appId });
  res.json(app);
}));

// Delete app
router.delete('/:appId', asyncHandler(async (req, res) => {
  const force = req.query.force === 'true';
  await deleteApp(req.params.appId, force);
  res.json({ success: true });
}));

// Get available image tags for an app
router.get('/:appId/tags', asyncHandler(async (req, res) => {
  const app = await getApp(req.params.appId);
  if (!app) {
    return res.status(404).json({ error: 'App not found' });
  }
  const tags = await getImageTagsForApp(app);
  res.json({ tags });
}));

// Test registry connection for an app
router.post('/:appId/registry/test', asyncHandler(async (req, res) => {
  const app = await getApp(req.params.appId);
  if (!app) {
    return res.status(404).json({ error: 'App not found' });
  }
  try {
    const tags = await getImageTagsForApp(app);
    res.json({ success: true, tagsFound: tags.length });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
}));

export default router;
