import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const MASK = '••••••••';
const SECRETS = /\$2y\$10|\{SHA\}|\$apr1\$|md5hash|hdr-secret/;

const APP: any = {
  id: 'demo', name: 'Demo', domain_template: '*.demo.example',
  registry: { type: 'ghcr', url: 'ghcr.io', repository: 'ns/demo', auth: { type: 'token' } },
  default_image_tag: 'latest',
  services: [{
    name: 'web', required: true, is_init_container: false, ports: { internal: 80 },
    routing: { enabled: true, strip_prefix: false, raw_labels: {
      'traefik.http.middlewares.demo-t1-web-gate.basicauth.users': 'erin:$apr1$hashhash',
      'traefik.http.routers.demo-t1-web.priority': '5',
    } },
  }],
  traefik: {
    default_middlewares: ['gate'],
    middlewares: {
      gate: { type: 'basicAuth', users: ['alice:$2y$10$abcdefghijklmnop', 'bob:{SHA}hash'], realm: 'Private' },
      hdr: { type: 'headers', custom_request_headers: { 'X-Api-Key': 'hdr-secret', 'X-Env': 'prod' } },
    },
  },
};
const TENANT_TRAEFIK = {
  host_aliases: ['a.example.org'],
  middleware_overrides: { web: ['gate'] },
  raw_labels: { web: {
    'traefik.http.middlewares.demo-t1-web-x.digestauth.users': 'dan:realm:md5hash',
    'traefik.http.routers.demo-t1-web.priority': '7',
  } },
};

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  for (const m of ['../services/app', '../adapters/registry', '../services/docker', '../services/tenant', '../services/adminAccess', '../services/traefikConfig']) vi.doUnmock(m);
});

type Role = 'viewer' | 'editor' | 'admin' | undefined;
const asRole = (role: Role): express.RequestHandler => (_req, res, next) => {
  if (role) res.locals.user = { email: 'u@example.test', role };
  next();
};

async function appsApp(role: Role) {
  const applyApp = vi.fn(async (def: any) => def);
  vi.doMock('../services/app', () => ({
    listApps: async () => [JSON.parse(JSON.stringify(APP))],
    getApp: async () => JSON.parse(JSON.stringify(APP)),
    createApp: vi.fn(), updateApp: vi.fn(async (d: any) => d), deleteApp: vi.fn(), listTrashedApps: vi.fn(),
    restoreApp: vi.fn(), purgeApp: vi.fn(), applyApp,
  }));
  vi.doMock('../adapters/registry', () => ({ getImageTagsForApp: vi.fn() }));
  const { default: router } = await import('../routes/apps');
  const { errorHandler } = await import('../middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use(asRole(role));
  app.use('/api/apps', router);
  app.use(errorHandler);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  return { app, applyApp };
}

async function tenantsApp(role: Role) {
  vi.doMock('../services/docker', () => ({
    getTenantInfo: vi.fn(), listTenants: vi.fn(), startTenant: vi.fn(), stopTenant: vi.fn(), restartTenant: vi.fn(),
  }));
  vi.doMock('../services/tenant', () => ({ createTenant: vi.fn(), deleteTenant: vi.fn(), updateTenant: vi.fn(), validateImageTag: vi.fn() }));
  vi.doMock('../services/adminAccess', () => ({ mintAdminAccess: vi.fn() }));
  vi.doMock('../services/traefikConfig', () => ({
    getTenantTraefik: async () => JSON.parse(JSON.stringify(TENANT_TRAEFIK)),
    updateTenantTraefik: async (_a: string, _t: string, body: unknown) => body,
  }));
  const { default: router } = await import('../routes/tenants');
  const app = express();
  app.use(express.json());
  app.use(asRole(role));
  app.use('/api/apps/:appId/tenants', router);
  return app;
}

function expectAppMasked(def: any) {
  expect(JSON.stringify(def)).not.toMatch(SECRETS);
  expect(def.traefik.middlewares.gate.users).toEqual([`alice:${MASK}`, `bob:${MASK}`]);
  expect(def.traefik.middlewares.gate.realm).toBe('Private');
  expect(def.traefik.middlewares.hdr.custom_request_headers).toEqual({ 'X-Api-Key': MASK, 'X-Env': 'prod' });
  const labels = def.services[0].routing.raw_labels;
  expect(labels['traefik.http.middlewares.demo-t1-web-gate.basicauth.users']).toBe(`erin:${MASK}`);
  expect(labels['traefik.http.routers.demo-t1-web.priority']).toBe('5');
  expect(def.traefik.default_middlewares).toEqual(['gate']);
}

describe('app definitions for non-admin readers', () => {
  it.each(['viewer', 'editor', undefined] as const)('GET /api/apps and /api/apps/:id mask credentials for %s', async (role) => {
    const { app } = await appsApp(role);
    expectAppMasked((await request(app).get('/api/apps').expect(200)).body[0]);
    expectAppMasked((await request(app).get('/api/apps/demo').expect(200)).body);
  });

  it('GET /api/apps/:id/traefik masks the library', async () => {
    const { app } = await appsApp('viewer');
    const res = await request(app).get('/api/apps/demo/traefik').expect(200);
    expect(JSON.stringify(res.body)).not.toMatch(SECRETS);
    expect(res.body.middlewares.gate.users[0]).toBe(`alice:${MASK}`);
  });

  it('admins get the stored values', async () => {
    const { app } = await appsApp('admin');
    expect((await request(app).get('/api/apps/demo').expect(200)).body).toEqual(APP);
    expect((await request(app).get('/api/apps').expect(200)).body[0]).toEqual(APP);
    expect((await request(app).get('/api/apps/demo/traefik').expect(200)).body).toEqual(APP.traefik);
  });
});

describe('tenant Traefik overrides for non-admin readers', () => {
  it.each(['viewer', 'editor', undefined] as const)('mask raw label credentials for %s', async (role) => {
    const res = await request(await tenantsApp(role)).get('/api/apps/demo/tenants/t1/traefik').expect(200);
    expect(JSON.stringify(res.body)).not.toMatch(SECRETS);
    expect(res.body.raw_labels.web['traefik.http.middlewares.demo-t1-web-x.digestauth.users']).toBe(`dan:${MASK}`);
    expect(res.body.raw_labels.web['traefik.http.routers.demo-t1-web.priority']).toBe('7');
    expect(res.body.middleware_overrides).toEqual({ web: ['gate'] });
    expect(res.body.host_aliases).toEqual(['a.example.org']);
  });

  it('admins get the stored values', async () => {
    const res = await request(await tenantsApp('admin')).get('/api/apps/demo/tenants/t1/traefik').expect(200);
    expect(res.body).toEqual(TENANT_TRAEFIK);
  });
});

describe('the mask placeholder is never written back', () => {
  it('an editor saving the masked app library keeps the stored hashes and headers', async () => {
    const { app, applyApp } = await appsApp('editor');
    const read = (await request(app).get('/api/apps/demo/traefik').expect(200)).body;
    await request(app).put('/api/apps/demo/traefik').send(read).expect(200);
    const saved = applyApp.mock.calls[0][0].traefik;
    expect(saved.middlewares.gate.users).toEqual(APP.traefik.middlewares.gate.users);
    expect(saved.middlewares.hdr.custom_request_headers['X-Api-Key']).toBe('hdr-secret');
    expect(JSON.stringify(saved)).not.toContain(MASK);
  });

  it('a placeholder with nothing stored to keep is a 400', async () => {
    const { app, applyApp } = await appsApp('editor');
    const body = { middlewares: { fresh: { type: 'basicAuth', users: [`carol:${MASK}`] } } };
    const res = await request(app).put('/api/apps/demo/traefik').send(body).expect(400);
    expect(res.body.error).toMatch(/masked placeholder/);
    const renamed = { middlewares: { gate: { type: 'basicAuth', users: [`mallory:${MASK}`] } } };
    await request(app).put('/api/apps/demo/traefik').send(renamed).expect(400);
    expect(applyApp).not.toHaveBeenCalled();
  });

  it('PUT /api/apps/:id refuses a placeholder even from an admin', async () => {
    const { app } = await appsApp('admin');
    const masked = JSON.parse(JSON.stringify(APP));
    masked.traefik.middlewares.gate.users = [`alice:${MASK}`];
    const res = await request(app).put('/api/apps/demo').send(masked).expect(400);
    expect(res.body.error).toMatch(/masked placeholder/);
  });

  it('tenant raw labels: restored from the stored value, refused otherwise', async () => {
    const { restoreTenantTraefik, redactTenantTraefik } = await import('../services/traefikRedaction');
    const masked = redactTenantTraefik(JSON.parse(JSON.stringify(TENANT_TRAEFIK)))!;
    expect(restoreTenantTraefik(masked, TENANT_TRAEFIK as any)).toEqual(TENANT_TRAEFIK);
    expect(() => restoreTenantTraefik(masked, undefined)).toThrow(/masked placeholder/);
  });

  it('global config: stored values restored for the dashboard, Overwatch block and a single middleware', async () => {
    const { restoreRoutingCredentials, restoreMiddlewareCredentials, redactRoutingCredentials } = await import('../services/traefikRedaction');
    const block = { host: 'ow', raw_labels: { 'traefik.http.middlewares.a.basicauth.users': 'carol:$apr1$hash,dave:$apr1$h2' } };
    expect(restoreRoutingCredentials(redactRoutingCredentials(block), block)).toEqual(block);
    const mws: any = { gate: APP.traefik.middlewares.gate };
    const masked = { gate: { ...mws.gate, users: [`bob:${MASK}`] } } as any;
    expect(restoreMiddlewareCredentials(masked, mws).gate.users).toEqual(['bob:{SHA}hash']);
  });
});
