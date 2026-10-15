import { Router, Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { runDocker } from '../utils/runDocker';
import { requireRole } from '../middleware/requireRole';
import { requireConfirmId } from '../middleware/confirmDestructive';
import {
  getTraefikConfig,
  updateTraefikConfig,
  listCertResolvers,
  upsertCertResolver,
  deleteCertResolver,
  listGlobalMiddlewares,
  upsertGlobalMiddleware,
  deleteGlobalMiddleware,
  getDashboardConfig,
  updateDashboardConfig,
  getOverwatchRouting,
  updateOverwatchRouting,
} from '../services/traefikConfig';
import { redactTraefikCredentials, redactMiddlewareCredentials, redactRoutingCredentials } from '../services/traefikRedaction';
import { TraefikGlobalSchema } from '../models/traefik';
import { loadConfig } from '../config';

const router = Router();

// Reads are open to every role, but inline credentials (basicAuth hashes, auth
// URLs, secret headers, cert-resolver env values) are for admins, the only role
// that can edit them. Explicit check: a missing role must not read as admin.
const isAdmin = (res: Response) => res.locals.user?.role === 'admin';

// ─── Full config ────────────────────────────────────────────────────────────

router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const t = await getTraefikConfig({ maskAllEnv: !isAdmin(res) });
  res.json((isAdmin(res) ? t : redactTraefikCredentials(t)) ?? null);
}));

router.put('/', requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
  const t = await updateTraefikConfig(req.body);
  res.json(t);
}));

// ─── Validation (dry run) ───────────────────────────────────────────────────

router.post('/validate', asyncHandler(async (req: Request, res: Response) => {
  const parsed = TraefikGlobalSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      errors: parsed.error.errors.map(e => ({ path: e.path.join('.'), message: e.message })),
    });
  }
  res.json({ ok: true });
}));

// ─── Cert resolvers ─────────────────────────────────────────────────────────

router.get('/cert-resolvers', asyncHandler(async (_req: Request, res: Response) => {
  res.json(await listCertResolvers({ maskAllEnv: !isAdmin(res) }));
}));

router.post('/cert-resolvers/:name', requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
  const r = await upsertCertResolver((req.params as Record<string, string>).name, req.body);
  res.json(r);
}));

router.put('/cert-resolvers/:name', requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
  const r = await upsertCertResolver((req.params as Record<string, string>).name, req.body);
  res.json(r);
}));

router.delete('/cert-resolvers/:name', requireRole('admin'), requireConfirmId('name'), asyncHandler(async (req: Request, res: Response) => {
  await deleteCertResolver((req.params as Record<string, string>).name);
  res.json({ success: true });
}));

// ─── Global middlewares ─────────────────────────────────────────────────────

router.get('/middlewares', asyncHandler(async (_req: Request, res: Response) => {
  const middlewares = await listGlobalMiddlewares();
  res.json(isAdmin(res) ? middlewares : redactMiddlewareCredentials(middlewares));
}));

router.post('/middlewares/:name', requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
  const m = await upsertGlobalMiddleware((req.params as Record<string, string>).name, req.body);
  res.json(m);
}));

router.put('/middlewares/:name', requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
  const m = await upsertGlobalMiddleware((req.params as Record<string, string>).name, req.body);
  res.json(m);
}));

router.delete('/middlewares/:name', requireRole('admin'), requireConfirmId('name'), asyncHandler(async (req: Request, res: Response) => {
  await deleteGlobalMiddleware((req.params as Record<string, string>).name);
  res.json({ success: true });
}));

// ─── Dashboard ──────────────────────────────────────────────────────────────

router.get('/dashboard', asyncHandler(async (_req: Request, res: Response) => {
  const dashboard = await getDashboardConfig();
  res.json((isAdmin(res) ? dashboard : redactRoutingCredentials(dashboard)) ?? null);
}));

router.put('/dashboard', requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
  res.json(await updateDashboardConfig(req.body));
}));

// ─── Overwatch self-routing ─────────────────────────────────────────────────

router.get('/overwatch', asyncHandler(async (_req: Request, res: Response) => {
  const routing = await getOverwatchRouting();
  res.json((isAdmin(res) ? routing : redactRoutingCredentials(routing)) ?? null);
}));

router.put('/overwatch', requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
  res.json(await updateOverwatchRouting(req.body));
}));

// ─── Reload Traefik container ───────────────────────────────────────────────
//
// Admin-only is enough here — there's nothing to typo into the URL (no path
// param to mismatch), and the UI already wraps this in a confirmation modal.
//
// Important: the client's HTTP request reaches this admin endpoint *through*
// Traefik. Awaiting `docker restart` before sending the response means the
// connection dies mid-flight and the browser surfaces "Failed to fetch" —
// even though the restart itself succeeded. Reply first, then kick the
// restart off fire-and-forget. Restart failures are logged server-side
// (rare — the Docker daemon is local) and visible in the next page reload.

router.post('/reload', requireRole('admin'), asyncHandler(async (_req: Request, res: Response) => {
  const config = loadConfig();
  const containerName = `${config.project.prefix}-traefik`;
  res.json({ success: true, container: containerName, note: 'Restart scheduled — brief routing pause expected.' });
  // Detach: the response is already on its way; we don't await this.
  // runDocker: allowlisted env (Overwatch's own secrets stay out of docker's) and a timeout.
  setImmediate(() => {
    runDocker('docker', ['restart', containerName], { timeoutMs: 120_000 }).catch((err: any) => {
      console.error(`[traefik reload] Failed to restart ${containerName}:`, err?.message || err);
    });
  });
}));

export default router;
