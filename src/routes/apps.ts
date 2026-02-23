import { Router } from 'express';
import { listApps, getApp, createApp, updateApp, deleteApp } from '../services/app';
import { getImageTagsForApp } from '../adapters/registry';
import { CreateAppSchema } from '../models/app';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

// Validate appId format on all routes that use it
const validateAppId: import('express').RequestHandler = (req, res, next) => {
  const { appId } = req.params;
  if (appId && !/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(appId)) {
    return res.status(400).json({ error: 'Invalid app ID format' });
  }
  next();
};

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

// Delete app
router.delete('/:appId', validateAppId, asyncHandler(async (req, res) => {
  const force = req.query.force === 'true';
  await deleteApp(req.params.appId, force);
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
