import { Router, Request, Response } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { asyncHandler } from '../utils/asyncHandler';
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
import { TraefikGlobalSchema } from '../models/traefik';
import { loadConfig } from '../config';

const execFileAsync = promisify(execFile);
const router = Router();

// ─── Full config ────────────────────────────────────────────────────────────

router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const t = await getTraefikConfig();
  res.json(t ?? null);
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

router.get('/cert-resolvers', asyncHandler(async (req: Request, res: Response) => {
  res.json(await listCertResolvers());
}));

router.post('/cert-resolvers/:name', requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
  const r = await upsertCertResolver(req.params.name, req.body);
  res.json(r);
}));

router.put('/cert-resolvers/:name', requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
  const r = await upsertCertResolver(req.params.name, req.body);
  res.json(r);
}));

router.delete('/cert-resolvers/:name', requireRole('admin'), requireConfirmId('name'), asyncHandler(async (req: Request, res: Response) => {
  await deleteCertResolver(req.params.name);
  res.json({ success: true });
}));

// ─── Global middlewares ─────────────────────────────────────────────────────

router.get('/middlewares', asyncHandler(async (req: Request, res: Response) => {
  res.json(await listGlobalMiddlewares());
}));

router.post('/middlewares/:name', requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
  const m = await upsertGlobalMiddleware(req.params.name, req.body);
  res.json(m);
}));

router.put('/middlewares/:name', requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
  const m = await upsertGlobalMiddleware(req.params.name, req.body);
  res.json(m);
}));

router.delete('/middlewares/:name', requireRole('admin'), requireConfirmId('name'), asyncHandler(async (req: Request, res: Response) => {
  await deleteGlobalMiddleware(req.params.name);
  res.json({ success: true });
}));

// ─── Dashboard ──────────────────────────────────────────────────────────────

router.get('/dashboard', asyncHandler(async (_req: Request, res: Response) => {
  res.json((await getDashboardConfig()) ?? null);
}));

router.put('/dashboard', requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
  res.json(await updateDashboardConfig(req.body));
}));

// ─── Overwatch self-routing ─────────────────────────────────────────────────

router.get('/overwatch', asyncHandler(async (_req: Request, res: Response) => {
  res.json((await getOverwatchRouting()) ?? null);
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
  setImmediate(() => {
    execFileAsync('docker', ['restart', containerName]).catch((err: any) => {
      console.error(`[traefik reload] Failed to restart ${containerName}:`, err?.message || err);
    });
  });
}));

export default router;
