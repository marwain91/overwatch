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
    expect(mw.hdr.custom_request_headers).toEqual({ Authorization: '••••••••', 'X-Env': '••••••••' });
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
      'traefik.http.middlewares.ow-h.headers.customresponseheaders.X-Frame': 'hdr-value',
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
      'X-Bearer': '••••••••', 'X-Env': '••••••••',
    });
    const labels = full.overwatch.raw_labels;
    const ow = new URL(labels['traefik.http.middlewares.ow-sso.forwardauth.address']);
    expect(ow.username + ow.password).toBe('');
    expect(ow.searchParams.get('signature')).toBe('••••••••');
    expect(ow.searchParams.get('a')).toBe('1');
    expect(labels['traefik.http.middlewares.ow-h.headers.customrequestheaders.X-Api-Key']).toBe('••••••••');
    // Fail-closed: a custom header name is not an allowlisted leaf, so its value is hidden too.
    expect(labels['traefik.http.middlewares.ow-h.headers.customresponseheaders.X-Frame']).toBe('••••••••');
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

describe('raw label values are masked fail-closed', () => {
  const LABELS = {
    'traefik.http.routers.ow.priority': '5',
    'traefik.http.routers.ow.middlewares': 'a@docker,b@docker',
    'traefik.http.services.ow.loadbalancer.server.port': '8080',
    'traefik.http.middlewares.m.ratelimit.average': '10',
    'traefik.http.middlewares.p.plugin.x.apikey': 'plugin-secret',
    'traefik.http.middlewares.f.forwardauth.tls.key': '/certs/private.key',
    'foo.bar.anything': 'unknown-value',
    'traefik.http.middlewares.h.headers.customrequestheaders.Cookie': 'session=cookie-secret',
    'traefik.http.middlewares.h.headers.customrequestheaders.X-Name': 'name-secret',
    'traefik.http.middlewares.h.headers.customresponseheaders.Path': 'path-secret',
    'traefik.http.middlewares.h.headers.sslproxyheaders.Port': 'port-secret',
    'traefik.http.middlewares.pl.plugin.vendor.name': 'plugin-name-secret',
    'traefik.http.services.ow.loadbalancer.sticky.cookie.name': 'sticky-name',
    'traefik.http.middlewares.i[0].ipallowlist.sourcerange[0]': '10.0.0.0/8',
  };

  async function labelsAs(role: 'viewer' | 'admin') {
    vi.doMock('../config/loader', () => ({ loadConfig: () => ({ traefik: { overwatch: { host: 'ow', raw_labels: LABELS } } }) }));
    vi.doMock('../services/app', () => ({ getApp: async () => null, applyApp: async () => ({}) }));
    const { default: router } = await import('../routes/traefik');
    const app = express();
    app.use((_req, res, next) => { res.locals.user = { email: 'u@example.test', role }; next(); });
    app.use('/api/traefik', router);
    return (await request(app).get('/api/traefik/overwatch').expect(200)).body.raw_labels;
  }

  it('hides unknown leaves from non-admins but keeps keys and allowlisted values', async () => {
    const labels = await labelsAs('viewer');
    expect(Object.keys(labels)).toEqual(Object.keys(LABELS));
    expect(JSON.stringify(labels)).not.toMatch(/plugin-secret|private\.key|unknown-value|cookie-secret|name-secret|path-secret|port-secret|plugin-name-secret/);
    for (const k of Object.keys(LABELS).filter(k => /customrequestheaders|customresponseheaders|sslproxyheaders|\.plugin\./.test(k))) {
      expect(labels[k], k).toBe('••••••••');
    }
    // The sticky cookie option is its own leaf and stays visible.
    expect(labels['traefik.http.services.ow.loadbalancer.sticky.cookie.name']).toBe('sticky-name');
    expect(labels['traefik.http.middlewares.p.plugin.x.apikey']).toBe('••••••••');
    expect(labels['traefik.http.middlewares.f.forwardauth.tls.key']).toBe('••••••••');
    expect(labels['foo.bar.anything']).toBe('••••••••');
    expect(labels['traefik.http.routers.ow.priority']).toBe('5');
    expect(labels['traefik.http.routers.ow.middlewares']).toBe('a@docker,b@docker');
    expect(labels['traefik.http.services.ow.loadbalancer.server.port']).toBe('8080');
    expect(labels['traefik.http.middlewares.m.ratelimit.average']).toBe('10');
    expect(labels['traefik.http.middlewares.i[0].ipallowlist.sourcerange[0]']).toBe('10.0.0.0/8');
  });

  it('admins see every value', async () => {
    expect(await labelsAs('admin')).toEqual(LABELS);
  });

  it('re-saving the masked labels restores each stored value by exact key', async () => {
    const { redactRawLabels, restoreRawLabels } = await import('../services/traefikRedaction');
    expect(restoreRawLabels(redactRawLabels(LABELS), LABELS)).toEqual(LABELS);
    // A placeholder under a key with nothing stored is refused, never persisted.
    expect(() => restoreRawLabels({ 'foo.bar.other': '••••••••' }, LABELS)).toThrow(/masked placeholder/);
    // Another key's value is not borrowed.
    expect(() => restoreRawLabels({ 'foo.bar.other': '••••••••' }, { 'foo.bar.anything': 'x' })).toThrow(/masked placeholder/);
  });
});

describe('fail-closed address, header and URL-in-text masking', () => {
  const M = '••••••••';
  const STORED: any = {
    sso: { type: 'forwardAuth', address: 'not a url but token=addr-secret' },
    hdr: { type: 'headers', custom_request_headers: { 'X-Session-Id': 'sess-secret' }, custom_response_headers: { 'X-Plain': 'plain-secret' } },
    redir: { type: 'redirectRegex', regex: '^https://svc:rx-secret@host/(.*)', replacement: 'https://host/$1?api_key=rep-secret&mode=1' },
    rp: { type: 'replacePath', path: '/go?token=path-secret' },
    rpr: { type: 'replacePathRegex', regex: '^/a', replacement: 'https://u:p4ss@h/x' },
  };
  const LEAKS = /addr-secret|sess-secret|plain-secret|rx-secret|rep-secret|path-secret|p4ss/;
  const LABELS = {
    'traefik.http.middlewares.r.redirectregex.regex': '^https://svc:lbl-secret@host/(.*)',
    'traefik.http.middlewares.r.redirectregex.replacement': 'https://host/$1?sig=lbl2-secret&x=1',
    'traefik.http.routers.ow.rule': 'Host(`a.example.com`) && PathPrefix(`/x`)',
  };

  async function as(role: 'viewer' | 'admin') {
    vi.doMock('../config/loader', () => ({ loadConfig: () => ({ traefik: { middlewares: STORED, overwatch: { host: 'ow', raw_labels: LABELS } } }) }));
    vi.doMock('../services/app', () => ({ getApp: async () => null, applyApp: async () => ({}) }));
    const { default: router } = await import('../routes/traefik');
    const app = express();
    app.use((_req, res, next) => { res.locals.user = { email: 'u@example.test', role }; next(); });
    app.use('/api/traefik', router);
    return (await request(app).get('/api/traefik').expect(200)).body;
  }

  it('viewers: unparsable address masked, every typed header value masked, URL credentials stripped in shown text', async () => {
    const t = await as('viewer');
    expect(JSON.stringify(t)).not.toMatch(LEAKS);
    expect(JSON.stringify(t)).not.toMatch(/lbl-secret|lbl2-secret/);
    const mw = t.middlewares;
    expect(mw.sso.address).toBe(M);
    expect(mw.hdr.custom_request_headers).toEqual({ 'X-Session-Id': M });
    expect(mw.hdr.custom_response_headers).toEqual({ 'X-Plain': M });
    expect(mw.redir.regex).toBe(`^https://${M}@host/(.*)`);
    expect(mw.redir.replacement).toBe(`https://host/$1?api_key=${M}&mode=1`);
    expect(mw.rp.path).toBe(`/go?token=${M}`);
    expect(mw.rpr.replacement).toBe(`https://${M}@h/x`);
    expect(t.overwatch.raw_labels['traefik.http.middlewares.r.redirectregex.regex']).toBe(`^https://${M}@host/(.*)`);
    expect(t.overwatch.raw_labels['traefik.http.middlewares.r.redirectregex.replacement']).toBe(`https://host/$1?sig=${M}&x=1`);
    expect(t.overwatch.raw_labels['traefik.http.routers.ow.rule']).toBe(LABELS['traefik.http.routers.ow.rule']);
  });

  it('admins see the stored values', async () => {
    const t = await as('admin');
    expect(t.middlewares).toEqual(STORED);
    expect(t.overwatch.raw_labels).toEqual(LABELS);
  });

  it('an editor re-saving the masked values keeps the stored ones; a placeholder with nothing stored is refused', async () => {
    const { redactMiddlewareCredentials, restoreMiddlewareCredentials, redactRawLabels, restoreRawLabels } =
      await import('../services/traefikRedaction');
    const masked = redactMiddlewareCredentials(STORED)!;
    expect(restoreMiddlewareCredentials(masked, STORED)).toEqual(STORED);
    expect(restoreRawLabels(redactRawLabels(LABELS), LABELS)).toEqual(LABELS);
    expect(() => restoreMiddlewareCredentials(masked, undefined)).toThrow(/masked placeholder/);
    expect(() => restoreMiddlewareCredentials({ x: { type: 'headers', custom_request_headers: { 'X-Session-Id': M } } } as any, undefined)).toThrow(/masked placeholder/);
    expect(() => restoreMiddlewareCredentials({ x: { type: 'redirectRegex', regex: `^https://${M}@h/`, replacement: '/' } } as any, undefined)).toThrow(/masked placeholder/);
    expect(() => restoreRawLabels({ 'traefik.http.middlewares.r.redirectregex.regex': `^https://${M}@h/` }, undefined)).toThrow(/masked placeholder/);
  });
});

