import { Router, type Response } from 'express';
import { listApps, getApp, createApp, updateApp, deleteApp, listTrashedApps, restoreApp, purgeApp } from '../services/app';
import { getImageTagsForApp } from '../adapters/registry';
import { CreateAppSchema, UpdateAppSchema } from '../models/app';
import { ValidationError } from '../utils/httpErrors';
import { asyncHandler } from '../utils/asyncHandler';
import { validateAppId } from '../middleware/validators';
import { requireConfirmId } from '../middleware/confirmDestructive';
import { requireRole } from '../middleware/requireRole';
import { getCurrentUserEmail } from '../utils/jwt';
import { getAppTraefik, updateAppTraefik } from '../services/traefikConfig';
import { assertAppRawLabelsOwned, assertNoGlobalMiddlewareShadowing } from '../services/traefikLabels';
import { redactAppDefinition, redactAppTraefik, assertNoMaskedCredentials, restoreServiceEnvMappings } from '../services/traefikRedaction';
import { assertServiceNamesValid, assertHealthcheckDurationsValid } from '../utils/validators';
import { loadConfig } from '../config';

const router = Router();

// Registry adapters throw plain Errors whose messages can name tokens, repos and
// hosts; the client gets a category, the detail stays in the server log.
function classifyTagError(error: any): string {
  const text = `${error?.message ?? ''} ${error?.cause?.code ?? ''} ${error?.code ?? ''}`;
  if (/HTTP (401|403)|denied access|unauthori[sz]ed|not configured/i.test(text)) {
    return 'Registry authentication failed. Check the registry credentials.';
  }
  if (/not found|HTTP 404/i.test(text)) {
    return 'Registry repository not found, or not accessible to the configured credentials.';
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|blocked address|private IP/i.test(text)) {
    return 'Registry unreachable. Check the registry URL and network access.';
  }
  return 'Failed to list tags from registry.';
}

// Reads are open to every role, but inline Traefik credentials (basicAuth hashes,
// auth raw labels) and static env_mapping values are for admins, the only role
// that can edit app definitions. Explicit check: a missing role must not read as admin.
const isAdmin = (res: Response) => res.locals.user?.role === 'admin';

// List all apps
router.get('/', asyncHandler(async (_req, res) => {
  const apps = await listApps();
  res.json(isAdmin(res) ? apps : apps.map(redactAppDefinition));
}));

// List trashed (soft-deleted) apps.
// Must be placed before the :appId sub-routes so it doesn't get shadowed.
router.get('/.trashed', asyncHandler(async (_req, res) => {
  const trashed = await listTrashedApps();
  // Each entry carries the full app definition.
  res.json(isAdmin(res) ? trashed : trashed.map(t => ({ ...t, app: redactAppDefinition(t.app) })));
}));

// Create a new app. Admin-only because the payload includes registry credentials
// and optional admin_access / backup configs.
router.post('/', requireRole('admin'), asyncHandler(async (req, res) => {
  const parseResult = CreateAppSchema.safeParse(req.body);
  if (!parseResult.success) {
    const errors = parseResult.error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
    return res.status(400).json({ error: `Invalid app definition: ${errors}` });
  }

  assertServiceNamesValid(parseResult.data.services);
  assertHealthcheckDurationsValid(parseResult.data.services);
  assertAppRawLabelsOwned(parseResult.data.id, parseResult.data.services);
  assertNoGlobalMiddlewareShadowing(parseResult.data.traefik, loadConfig().traefik);
  assertNoMaskedCredentials(parseResult.data);
  const app = await createApp(parseResult.data);
  res.status(201).json(app);
}));

// Get app details
router.get('/:appId', validateAppId, asyncHandler(async (req, res) => {
  const app = await getApp((req.params as Record<string, string>).appId);
  if (!app) {
    return res.status(404).json({ error: 'App not found' });
  }
  res.json(isAdmin(res) ? app : redactAppDefinition(app));
}));

// Update app config. Admin-only — update payload can change registry creds,
// admin_access (token-mint URL template), and backup targets.
router.put('/:appId', validateAppId, requireRole('admin'), asyncHandler(async (req, res) => {
  const appId = (req.params as Record<string, string>).appId;
  // The path id wins over any body id. Parsing here also strips fields outside
  // the schema (e.g. createdAt) that the shallow merge in updateApp would keep.
  const parseResult = UpdateAppSchema.safeParse({ ...req.body, id: appId });
  if (!parseResult.success) {
    const errors = parseResult.error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new ValidationError(`Invalid app definition: ${errors}`);
  }
  assertServiceNamesValid(parseResult.data.services);
  assertHealthcheckDurationsValid(parseResult.data.services);
  assertAppRawLabelsOwned(appId, parseResult.data.services);
  assertNoGlobalMiddlewareShadowing(parseResult.data.traefik, loadConfig().traefik);
  // A copy of a non-admin read carries masked static env values; keep the stored ones.
  const data = restoreServiceEnvMappings(parseResult.data, await getApp(appId));
  assertNoMaskedCredentials(data);
  const app = await updateApp(data);
  res.json(app);
}));

// Restore a soft-deleted app.
router.post('/:appId/restore', validateAppId, requireRole('admin'), asyncHandler(async (req, res) => {
  const app = await restoreApp((req.params as Record<string, string>).appId);
  res.json({ success: true, app });
}));

// Permanently purge a soft-deleted app from the trash.
router.delete('/:appId/purge', validateAppId, requireRole('admin'), requireConfirmId('appId'), asyncHandler(async (req, res) => {
  await purgeApp((req.params as Record<string, string>).appId);
  res.json({ success: true });
}));

// Delete app. force=true with active tenants now soft-deletes (moves to trash)
// instead of dropping the record. Requires X-Confirm-Id header matching appId.
router.delete('/:appId', validateAppId, requireRole('admin'), requireConfirmId('appId'), asyncHandler(async (req, res) => {
  const force = req.query.force === 'true';
  const actor = getCurrentUserEmail(req) || 'unknown';
  await deleteApp((req.params as Record<string, string>).appId, force, actor);
  res.json({ success: true });
}));

// Get available image tags for an app.
// Failures from the upstream registry (missing scope, 4xx/5xx, network) are
// returned as 200 with `{ tags: [], error }` so the UI can show the reason
// inline without a noisy 500 in the browser console — listing tags is a
// best-effort convenience, not a hard dependency.
router.get('/:appId/tags', validateAppId, asyncHandler(async (req, res) => {
  const app = await getApp((req.params as Record<string, string>).appId);
  if (!app) {
    return res.status(404).json({ error: 'App not found' });
  }
  try {
    const tags = await getImageTagsForApp(app);
    res.json({ tags });
  } catch (error: any) {
    console.error(`Tag listing failed for app ${app.id}:`, error?.message || error);
    res.json({ tags: [], error: classifyTagError(error) });
  }
}));

// Test registry connection for an app — editor+ (reads non-secret status).
router.post('/:appId/registry/test', validateAppId, requireRole('editor'), asyncHandler(async (req, res) => {
  const app = await getApp((req.params as Record<string, string>).appId);
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
// Writes are admin-only like PUT /:appId: default_middlewares attach to every
// tenant router, so a forwardAuth entry would hand every tenant user's Cookie
// and Authorization headers to its address.
router.get('/:appId/traefik', validateAppId, asyncHandler(async (req, res) => {
  const t = await getAppTraefik((req.params as Record<string, string>).appId);
  res.json((isAdmin(res) ? t : redactAppTraefik(t)) ?? null);
}));

router.put('/:appId/traefik', validateAppId, requireRole('admin'), asyncHandler(async (req, res) => {
  const t = await updateAppTraefik((req.params as Record<string, string>).appId, req.body);
  res.json(t);
}));

export default router;
