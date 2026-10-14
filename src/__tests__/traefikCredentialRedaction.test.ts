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
    expect(mw.sso.address).toBe('https://••••••••@auth.example.com/verify');
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
    expect(labels['traefik.http.middlewares.ow-sso.forwardauth.address']).toMatch(/^https:\/\/••••••••@auth\.example\.com\//);
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
    // Whole-value masking: a value with `@` or a credential-named parameter is hidden entirely.
    expect(mw.redir.regex).toBe(M);
    expect(mw.redir.replacement).toBe(M);
    expect(mw.rp.path).toBe(M);
    expect(mw.rpr.replacement).toBe(M);
    expect(mw.rpr.regex).toBe('^/a');
    expect(t.overwatch.raw_labels['traefik.http.middlewares.r.redirectregex.regex']).toBe(M);
    expect(t.overwatch.raw_labels['traefik.http.middlewares.r.redirectregex.replacement']).toBe(M);
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
    expect(() => restoreMiddlewareCredentials({ x: { type: 'redirectRegex', regex: M, replacement: '/' } } as any, undefined)).toThrow(/masked placeholder/);
    expect(() => restoreRawLabels({ 'traefik.http.middlewares.r.redirectregex.regex': M }, undefined)).toThrow(/masked placeholder/);
  });
});

describe('whole-value masking of free text (round 5)', () => {
  const M = '••••••••';
  const leak = (v: string) => ({ type: 'redirectRegex', regex: v, replacement: '/x' });

  async function r() { return import('../services/traefikRedaction'); }

  it.each([
    ['https://user:p@ss@host/', 'extra @ in the password'],
    ['https://a.example/?next=https%3A%2F%2Fu%3Apw%40h%2F', 'URL embedded in a query'],
    ['$1://u:pw@h/', 'scheme from a backreference'],
    ['//u:pw@h/', 'scheme-relative URL'],
    ['u:pw@h', 'bare userinfo'],
    ['^(.*)@example\\.com', '@ in a regex'],
    ['/go?sessionid=abc', 'session query parameter'],
    ['/go;jwt=abc', 'semicolon parameter'],
    ['/go#access_token=abc', 'fragment parameter'],
    ['/go?a=1&PWD=abc', 'pwd parameter'],
    ['/go?otp=123', 'otp parameter'],
  ])('masks %s (%s) for viewers, in typed fields and allowlisted raw labels', async (value) => {
    const { redactMiddlewareCredentials, redactRawLabels } = await r();
    expect((redactMiddlewareCredentials({ x: leak(value) } as any) as any).x.regex).toBe(M);
    expect(redactRawLabels({ 'traefik.http.middlewares.x.redirectregex.regex': value })['traefik.http.middlewares.x.redirectregex.regex']).toBe(M);
  });

  it('shows clean values, and masks every string field of a typed middleware', async () => {
    const { redactMiddlewareCredentials, redactRawLabels } = await r();
    const red: any = redactMiddlewareCredentials({
      a: { type: 'redirectRegex', regex: '^https://old\\.example\\.com/(.*)', replacement: 'https://new.example.com/$1', permanent: true },
      b: { type: 'ipAllowList', source_range: ['10.0.0.0/8', 'a@b'] },
      c: { type: 'chain', middlewares: ['x', 'y?token=1'] },
    } as any);
    expect(red.a).toEqual({ type: 'redirectRegex', regex: '^https://old\\.example\\.com/(.*)', replacement: 'https://new.example.com/$1', permanent: true });
    expect(red.b.source_range).toEqual(['10.0.0.0/8', M]);
    expect(red.c.middlewares).toEqual(['x', M]);
    expect(redactRawLabels({ 'traefik.http.routers.x.priority': '5' })['traefik.http.routers.x.priority']).toBe('5');
  });

  it('forwardAuth: non-http scheme masked, userinfo shown as placeholder, secret params and fragment masked', async () => {
    const { redactMiddlewareCredentials, redactRawLabels } = await r();
    const addr = (a: string) => (redactMiddlewareCredentials({ x: { type: 'forwardAuth', address: a } } as any) as any).x.address;
    expect(addr('ftp://auth.example.com/v')).toBe(M);
    expect(addr('javascript:alert(1)')).toBe(M);
    expect(addr('https://u:pw@auth.example.com/v')).toBe(`https://${M}@auth.example.com/v`);
    expect(addr('https://auth.example.com/v?sessionid=abc&x=1')).toContain('x=1');
    expect(addr('https://auth.example.com/v?sessionid=abc&x=1')).not.toContain('abc');
    expect(addr('https://auth.example.com/v#frag-secret')).toBe(`https://auth.example.com/v#${M}`);
    expect(addr('https://auth.example.com/v')).toBe('https://auth.example.com/v');
    expect(redactRawLabels({ 'traefik.http.middlewares.x.forwardauth.address': 'ftp://h/' })['traefik.http.middlewares.x.forwardauth.address']).toBe(M);
  });

  it('an editor sending the clean forwardAuth URL removes the credentials instead of having them restored', async () => {
    const { restoreMiddlewareCredentials, redactMiddlewareCredentials } = await r();
    const stored: any = { x: { type: 'forwardAuth', address: 'https://u:pw@auth.example.com/v' } };
    const masked = redactMiddlewareCredentials(stored) as any;
    expect(restoreMiddlewareCredentials(masked, stored)).toEqual(stored);
    const clean = { x: { type: 'forwardAuth', address: 'https://auth.example.com/v' } } as any;
    expect((restoreMiddlewareCredentials(clean, stored) as any).x.address).toBe('https://auth.example.com/v');
    expect(() => restoreMiddlewareCredentials(masked, undefined)).toThrow(/masked placeholder/);
  });

  it('healthcheck headers (user-keyed) and request-matching rules are masked; other rules shown', async () => {
    const { redactRawLabels, restoreRawLabels } = await r();
    const labels = {
      'traefik.http.services.s.loadbalancer.healthcheck.headers.Path': 'hc-secret',
      'traefik.http.services.s.loadbalancer.healthcheck.path': '/health',
      'traefik.http.routers.a.rule': 'Host(`a.example.com`) && Header(`X-Key`, `k-secret`)',
      'traefik.http.routers.b.rule': 'Host(`a.example.com`) && QueryRegexp(`t`, `s3`)',
      'traefik.http.routers.c.rule': 'Host(`a.example.com`) && PathPrefix(`/x`)',
    };
    const red = redactRawLabels(labels);
    expect(red['traefik.http.services.s.loadbalancer.healthcheck.headers.Path']).toBe(M);
    expect(red['traefik.http.services.s.loadbalancer.healthcheck.path']).toBe('/health');
    expect(red['traefik.http.routers.a.rule']).toBe(M);
    expect(red['traefik.http.routers.b.rule']).toBe(M);
    expect(red['traefik.http.routers.c.rule']).toBe(labels['traefik.http.routers.c.rule']);
    expect(restoreRawLabels(red, labels)).toEqual(labels);
    expect(() => restoreRawLabels(red, undefined)).toThrow(/masked placeholder/);
  });

  it('editor round trip of unchanged values keeps the stored ones; admin routes still return everything', async () => {
    const { redactMiddlewareCredentials, restoreMiddlewareCredentials } = await r();
    const stored: any = { r: { type: 'redirectRegex', regex: '^https://u:p@ss@host/(.*)', replacement: '/x?token=t' }, ok: { type: 'compress' } };
    expect(restoreMiddlewareCredentials(redactMiddlewareCredentials(stored) as any, stored)).toEqual(stored);
  });
});

