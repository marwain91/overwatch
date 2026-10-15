import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// `{ static: ... }` env_mapping values are literal environment values for the
// tenant containers (API keys, SMTP passwords), so non-admins get them masked.

const MASK = '••••••••';
const APP: any = {
  id: 'demo', name: 'Demo', domain_template: '*.demo.example',
  registry: { type: 'ghcr', url: 'ghcr.io', repository: 'ns/demo', auth: { type: 'token' } },
  default_image_tag: 'latest',
  services: [{
    name: 'web', required: true, is_init_container: false, ports: { internal: 80 },
    env_mapping: { DB_HOST: 'DB_HOST', API_KEY: { static: 'sk-live-secret' }, NODE_ENV: { static: 'production' } },
  }, { name: 'worker', required: false, is_init_container: false }],
};

type Role = 'viewer' | 'editor' | 'admin' | undefined;

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  for (const m of ['../services/app', '../adapters/registry']) vi.doUnmock(m);
});

async function appsApp(role: Role) {
  const copy = () => JSON.parse(JSON.stringify(APP));
  const createApp = vi.fn(async (d: any) => d);
  const updateApp = vi.fn(async (d: any) => d);
  vi.doMock('../services/app', () => ({
    listApps: async () => [copy()],
    listTrashedApps: async () => [{ app: copy(), deletedAt: '2026-01-01T00:00:00.000Z', deletedBy: 'a@b.c', tenantCount: 0 }],
    getApp: async () => copy(),
    createApp, updateApp, deleteApp: vi.fn(), restoreApp: vi.fn(), purgeApp: vi.fn(), applyApp: vi.fn(),
  }));
  vi.doMock('../adapters/registry', () => ({ getImageTagsForApp: vi.fn() }));
  const { default: router } = await import('../routes/apps');
  const { errorHandler } = await import('../middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => { if (role) res.locals.user = { email: 'u@example.test', role }; next(); });
  app.use('/api/apps', router);
  app.use(errorHandler);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  return { app, createApp, updateApp };
}

const expectMasked = (def: any) => {
  expect(JSON.stringify(def)).not.toContain('sk-live-secret');
  expect(def.services[0].env_mapping).toEqual({ DB_HOST: 'DB_HOST', API_KEY: { static: MASK }, NODE_ENV: { static: MASK } });
  expect(def.services[1]).toEqual(APP.services[1]);
};

describe('reads', () => {
  it.each(['viewer', 'editor', undefined] as const)('mask static env_mapping values on every app read route for %s', async (role) => {
    const { app } = await appsApp(role);
    expectMasked((await request(app).get('/api/apps').expect(200)).body[0]);
    expectMasked((await request(app).get('/api/apps/demo').expect(200)).body);
    expectMasked((await request(app).get('/api/apps/.trashed').expect(200)).body[0].app);
  });

  it('admins get the stored values', async () => {
    const { app } = await appsApp('admin');
    expect((await request(app).get('/api/apps/demo').expect(200)).body).toEqual(APP);
  });
});

describe('writes', () => {
  it('PUT /:id keeps the stored value behind a masked one', async () => {
    const read = (await request((await appsApp('viewer')).app).get('/api/apps/demo').expect(200)).body;
    vi.resetModules();
    const { app, updateApp } = await appsApp('admin');
    const { id: _id, ...body } = read;
    await request(app).put('/api/apps/demo').send(body).expect(200);
    expect(updateApp.mock.calls[0][0].services[0].env_mapping).toEqual(APP.services[0].env_mapping);
  });

  it('PUT /:id refuses a masked value with nothing stored for that service and key', async () => {
    const { app, updateApp } = await appsApp('admin');
    const services = JSON.parse(JSON.stringify(APP.services));
    services[1].env_mapping = { API_KEY: { static: MASK } };
    const res = await request(app).put('/api/apps/demo').send({ services }).expect(400);
    expect(res.body.error).toMatch(/masked placeholder/);
    expect(updateApp).not.toHaveBeenCalled();
  });

  it('POST / refuses a masked value', async () => {
    const { app, createApp } = await appsApp('admin');
    const body = JSON.parse(JSON.stringify({ ...APP, id: 'fresh' }));
    body.services[0].env_mapping.API_KEY = { static: MASK };
    const res = await request(app).post('/api/apps').send(body).expect(400);
    expect(res.body.error).toMatch(/masked placeholder/);
    expect(createApp).not.toHaveBeenCalled();
  });
});
