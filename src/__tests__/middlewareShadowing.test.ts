import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { AppDefinition } from '../models/app';
import type { TraefikGlobal } from '../models/traefik';

// An app middleware must not redefine a global one: the global name is what an
// admin lists in traefik.default_middlewares (an auth or ipAllowList gate).

const GLOBAL: TraefikGlobal = {
  log_level: 'INFO',
  middlewares: {
    gate: { type: 'basicAuth', users: ['ops:$apr1$global'] },
    secure: { type: 'chain', middlewares: ['gate'] },
  },
  default_middlewares: ['gate'],
};

const baseApp = (traefik: AppDefinition['traefik']): AppDefinition => ({
  id: 'myapp', name: 'MyApp', domain_template: '*.app.example.com',
  registry: { type: 'ghcr', url: 'ghcr.io', repository: 'ns/myapp', auth: { type: 'token' } },
  services: [], default_image_tag: 'latest', traefik,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
} as AppDefinition);

const service = (middlewares?: string[]) => ({
  name: 'web', required: true, is_init_container: false, ports: { internal: 80 },
  routing: { enabled: true, strip_prefix: false, middlewares },
}) as any;

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  for (const m of ['../services/app', '../adapters/registry', '../config', '../config/loader']) vi.doUnmock(m);
});

describe('generation: the global definition wins over an app middleware of the same name', () => {
  it('emits the global spec and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { buildTraefikLabels } = await import('../services/traefikLabels');
    const labels = buildTraefikLabels({
      app: baseApp({ middlewares: { gate: { type: 'forwardAuth', address: 'https://collector.example.net/' } } }),
      tenantId: 't1', domain: 't1.app.example.com', certResolverName: 'cf',
      service: service(), traefik: GLOBAL,
    });
    const joined = labels.join('\n');
    expect(joined).toContain('traefik.http.middlewares.myapp-t1-web-gate.basicauth.users=ops:$apr1$global');
    expect(joined).not.toMatch(/forwardauth|collector/);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/"gate".*global/);
  });

  it('also inside a chain', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { buildTraefikLabels } = await import('../services/traefikLabels');
    const labels = buildTraefikLabels({
      app: baseApp({ middlewares: { gate: { type: 'ipAllowList', source_range: ['0.0.0.0/0'] } } }),
      tenantId: 't1', domain: 't1.app.example.com', certResolverName: 'cf',
      service: service(['secure']), traefik: { ...GLOBAL, default_middlewares: [] },
    });
    const joined = labels.join('\n');
    expect(joined).toContain('myapp-t1-web-gate.basicauth.users=ops:$apr1$global');
    expect(joined).not.toContain('ipallowlist');
  });

  it('an app-only name still resolves from the app library, without a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { buildTraefikLabels } = await import('../services/traefikLabels');
    const labels = buildTraefikLabels({
      app: baseApp({ middlewares: { rl: { type: 'rateLimit', average: 5 } } }),
      tenantId: 't1', domain: 't1.app.example.com', certResolverName: 'cf',
      service: service(['rl']), traefik: GLOBAL,
    });
    expect(labels).toContain('traefik.http.middlewares.myapp-t1-web-rl.ratelimit.average=5');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('doctor', () => {
  it('warns about an app middleware that a global one overrides', async () => {
    const { validateTraefik } = await import('../services/traefikDoctor');
    const issues = validateTraefik({
      config: { project: { name: 'p', prefix: 'p', db_prefix: 'p' }, database: {}, traefik: GLOBAL } as any,
      apps: [baseApp({ middlewares: { gate: { type: 'rateLimit', average: 1 }, rl: { type: 'rateLimit', average: 1 } } })],
      tenantOverrides: new Map(),
      presentEnvVars: new Set(),
    });
    expect(issues).toEqual([expect.objectContaining({ severity: 'warning', scope: 'app:myapp.traefik.middlewares.gate' })]);
  });
});

describe('write paths refuse an app middleware named like a global one', () => {
  const APP = { ...baseApp({}), services: [{ name: 'web', image_suffix: 'web', ports: { internal: 80 } }] };

  async function mount() {
    const applyApp = vi.fn(async (def: any) => ({ result: 'updated', app: def, changedKeys: [] }));
    const createApp = vi.fn(async (d: any) => d);
    const updateApp = vi.fn(async (d: any) => d);
    vi.doMock('../services/app', () => ({
      listApps: async () => [APP], listTrashedApps: async () => [], getApp: async () => JSON.parse(JSON.stringify(APP)),
      createApp, updateApp, deleteApp: vi.fn(), restoreApp: vi.fn(), purgeApp: vi.fn(), applyApp,
    }));
    vi.doMock('../adapters/registry', () => ({ getImageTagsForApp: vi.fn() }));
    const config = { project: { name: 'T', prefix: 't', db_prefix: 't' }, traefik: GLOBAL };
    vi.doMock('../config', async () => ({ ...(await vi.importActual<any>('../config')), loadConfig: () => config }));
    vi.doMock('../config/loader', async () => ({ ...(await vi.importActual<any>('../config/loader')), loadConfig: () => config }));
    const { default: router } = await import('../routes/apps');
    const { errorHandler } = await import('../middleware/errorHandler');
    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => { res.locals.user = { email: 'a@example.test', role: 'admin' }; next(); });
    app.use('/api/apps', router);
    app.use(errorHandler);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    return { app, applyApp, createApp, updateApp };
  }

  const shadowing = { middlewares: { gate: { type: 'forwardAuth', address: 'https://collector.example.net/' } } };

  it('PUT /:id/traefik is a 400 naming the middleware, and nothing is written', async () => {
    const { app, applyApp } = await mount();
    const res = await request(app).put('/api/apps/myapp/traefik').send(shadowing).expect(400);
    expect(res.body.error).toMatch(/"gate".*global/);
    expect(applyApp).not.toHaveBeenCalled();
    await request(app).put('/api/apps/myapp/traefik').send({ middlewares: { own_gate: shadowing.middlewares.gate } }).expect(200);
  });

  it('POST / and PUT /:id with such a library are a 400', async () => {
    const { app, createApp, updateApp } = await mount();
    const { createdAt: _c, updatedAt: _u, ...body } = APP as any;
    await request(app).post('/api/apps').send({ ...body, traefik: shadowing }).expect(400);
    await request(app).put('/api/apps/myapp').send({ ...body, traefik: shadowing }).expect(400);
    expect(createApp).not.toHaveBeenCalled();
    expect(updateApp).not.toHaveBeenCalled();
  });
});
