import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const TRAEFIK = {
  cert_resolvers: [],
  middlewares: {
    gate: { type: 'basicAuth', users: ['alice:$2y$10$abcdefghijklmnop', 'bob:{SHA}hash'], realm: 'Private' },
    sso: { type: 'forwardAuth', address: 'https://svc:tok3n@auth.example.com/verify', auth_response_headers: ['X-User'] },
    limit: { type: 'rateLimit', average: 10 },
    hdr: { type: 'headers', custom_request_headers: { Authorization: 'Bearer abc123', 'X-Env': 'prod' } },
  },
  overwatch: {
    host: 'ow.example.com',
    raw_labels: {
      'traefik.http.middlewares.ow-auth.basicauth.users': 'carol:$apr1$hashhash',
      'traefik.http.routers.ow.priority': '5',
    },
  },
  dashboard: { enabled: true, host: 'd.example.com', raw_labels: { 'traefik.http.middlewares.d.digestauth.users': 'dan:realm:md5hash' } },
};
const SECRETS = /\$2y\$10|\{SHA\}|\$apr1\$|md5hash|tok3n|abc123/;

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../config/loader');
});

async function appAs(role: 'viewer' | 'editor' | 'admin' | undefined) {
  vi.doMock('../config/loader', () => ({ loadConfig: () => ({ traefik: TRAEFIK }) }));
  vi.doMock('../services/app', () => ({ getApp: async () => null, applyApp: async () => ({}) }));
  const { default: router } = await import('../routes/traefik');
  const app = express();
  app.use((_req, res, next) => { if (role) res.locals.user = { email: 'u@example.test', role }; next(); });
  app.use('/api/traefik', router);
  return app;
}

describe('global Traefik config credentials for non-admins', () => {
  it.each(['viewer', 'editor', undefined] as const)('GET / masks credential fields for %s', async (role) => {
    const res = await request(await appAs(role)).get('/api/traefik').expect(200);
    expect(JSON.stringify(res.body)).not.toMatch(SECRETS);
    const mw = res.body.middlewares;
    expect(mw.gate.users).toEqual(['alice:••••••••', 'bob:••••••••']);
    expect(mw.gate.realm).toBe('Private');
    expect(mw.sso.address).toBe('https://auth.example.com/verify');
    expect(mw.hdr.custom_request_headers).toEqual({ Authorization: '••••••••', 'X-Env': 'prod' });
    expect(mw.limit).toEqual({ type: 'rateLimit', average: 10 });
    expect(res.body.overwatch.raw_labels['traefik.http.middlewares.ow-auth.basicauth.users']).toBe('carol:••••••••');
    expect(res.body.overwatch.raw_labels['traefik.http.routers.ow.priority']).toBe('5');
  });

  it('the sub-resources are masked as well', async () => {
    const app = await appAs('viewer');
    for (const p of ['/middlewares', '/overwatch', '/dashboard']) {
      const res = await request(app).get(`/api/traefik${p}`).expect(200);
      expect(JSON.stringify(res.body), p).not.toMatch(SECRETS);
    }
    const list = await request(app).get('/api/traefik/middlewares');
    expect(list.body.gate.users[0]).toBe('alice:••••••••');
  });

  it('admins get the stored values (needed to edit them)', async () => {
    const app = await appAs('admin');
    const res = await request(app).get('/api/traefik').expect(200);
    expect(res.body.middlewares.gate.users).toEqual(TRAEFIK.middlewares.gate.users);
    expect(res.body.middlewares.sso.address).toBe(TRAEFIK.middlewares.sso.address);
    expect(res.body.overwatch.raw_labels).toEqual(TRAEFIK.overwatch.raw_labels);
    const mw = await request(app).get('/api/traefik/middlewares').expect(200);
    expect(mw.body.gate.users).toEqual(TRAEFIK.middlewares.gate.users);
  });
});

describe('credential-bearing raw labels and broader typed rules', () => {
  const EXTRA = {
    middlewares: {
      sso: { type: 'forwardAuth', address: 'https://auth.example.com/verify?token=qs-secret&mode=strict&apiKey=k-secret' },
      hdr: { type: 'headers', custom_request_headers: {
        'Proxy-Authorization': 'pa-secret', 'X-Signature': 'sig-secret', 'X-Credential': 'cred-secret',
        'X-Bearer': 'bearer-secret', 'X-Env': 'prod',
      } },
    },
    overwatch: { host: 'ow.example.com', raw_labels: {
      'traefik.http.middlewares.ow-sso.forwardauth.address': 'https://u:pw-secret@auth.example.com/v?signature=sg-secret&a=1',
      'traefik.http.middlewares.ow-h.headers.customrequestheaders.X-Api-Key': 'rawhdr-secret',
      'traefik.http.middlewares.ow-h.headers.customresponseheaders.X-Frame': 'keep-me',
      'traefik.http.routers.ow.priority': '5',
    } },
    dashboard: { enabled: true, host: 'd.example.com', raw_labels: {
      'traefik.http.middlewares.d-sso.forwardauth.address': 'https://auth.example.com/v?password=dash-secret',
    } },
  };
  const LEAKS = /qs-secret|k-secret|pa-secret|sig-secret|cred-secret|bearer-secret|pw-secret|sg-secret|rawhdr-secret|dash-secret/;

  async function get(role: 'viewer' | 'admin', p = '') {
    vi.doMock('../config/loader', () => ({ loadConfig: () => ({ traefik: EXTRA }) }));
    vi.doMock('../services/app', () => ({ getApp: async () => null, applyApp: async () => ({}) }));
    const { default: router } = await import('../routes/traefik');
    const app = express();
    app.use((_req, res, next) => { res.locals.user = { email: 'u@example.test', role }; next(); });
    app.use('/api/traefik', router);
    return request(app).get(`/api/traefik${p}`).expect(200);
  }

  it('masks them for non-admins on the full config and the sub-resources', async () => {
    const full = (await get('viewer')).body;
    expect(JSON.stringify(full)).not.toMatch(LEAKS);
    for (const p of ['/overwatch', '/dashboard', '/middlewares']) {
      expect(JSON.stringify((await get('viewer', p)).body), p).not.toMatch(LEAKS);
    }
    const sso = new URL(full.middlewares.sso.address);
    expect(sso.searchParams.get('token')).toBe('••••••••');
    expect(sso.searchParams.get('apiKey')).toBe('••••••••');
    expect(sso.searchParams.get('mode')).toBe('strict');
    expect(full.middlewares.hdr.custom_request_headers).toEqual({
      'Proxy-Authorization': '••••••••', 'X-Signature': '••••••••', 'X-Credential': '••••••••',
      'X-Bearer': '••••••••', 'X-Env': 'prod',
    });
    const labels = full.overwatch.raw_labels;
    const ow = new URL(labels['traefik.http.middlewares.ow-sso.forwardauth.address']);
    expect(ow.username + ow.password).toBe('');
    expect(ow.searchParams.get('signature')).toBe('••••••••');
    expect(ow.searchParams.get('a')).toBe('1');
    expect(labels['traefik.http.middlewares.ow-h.headers.customrequestheaders.X-Api-Key']).toBe('••••••••');
    expect(labels['traefik.http.middlewares.ow-h.headers.customresponseheaders.X-Frame']).toBe('keep-me');
    expect(labels['traefik.http.routers.ow.priority']).toBe('5');
  });

  it('admins still get the stored values', async () => {
    const full = (await get('admin')).body;
    expect(full.middlewares.sso.address).toBe(EXTRA.middlewares.sso.address);
    expect(full.overwatch.raw_labels).toEqual(EXTRA.overwatch.raw_labels);
    expect(full.dashboard.raw_labels).toEqual(EXTRA.dashboard.raw_labels);
  });

  it('a saved-back masked value is restored from storage, or refused when nothing is stored', async () => {
    const { redactRoutingCredentials, restoreRoutingCredentials, redactMiddlewareCredentials, restoreMiddlewareCredentials } =
      await import('../services/traefikRedaction');
    const masked = redactRoutingCredentials(EXTRA.overwatch);
    expect(restoreRoutingCredentials(masked, EXTRA.overwatch)).toEqual(EXTRA.overwatch);
    expect(() => restoreRoutingCredentials(masked, undefined)).toThrow(/masked placeholder/);
    const mw = redactMiddlewareCredentials(EXTRA.middlewares as any)!;
    expect(restoreMiddlewareCredentials(mw, EXTRA.middlewares as any)).toEqual(EXTRA.middlewares);
    expect(() => restoreMiddlewareCredentials(mw, undefined)).toThrow(/masked placeholder/);
  });
});
