import { describe, it, expect } from 'vitest';
import { buildTraefikLabels, assertAppRawLabelsOwned, assertTenantRawLabelsOwned } from '../services/traefikLabels';
import { buildOverwatchComposeYml } from '../services/infraComposeGenerator';
import {
  isBlockedRawLabelKey,
  rawLabelOwnerForRouter,
  rawLabelOwnerForAppService,
  rawLabelProblem,
} from '../models/traefik';
import type { AppDefinition } from '../models/app';

const app = {
  id: 'myapp', name: 'MyApp', domain_template: '*.app.example.com',
  registry: { type: 'ghcr', url: 'ghcr.io', repository: 'ns/myapp', auth: { type: 'token' } },
  services: [], default_image_tag: 'latest',
} as unknown as AppDefinition;

function labelsFor(appRaw: Record<string, string> | undefined, tenantRaw?: Record<string, string>) {
  return buildTraefikLabels({
    app, tenantId: 't1', domain: 't1.app.example.com', certResolverName: 'cf',
    service: { name: 'web', required: true, is_init_container: false, ports: { internal: 80 },
      routing: { enabled: true, strip_prefix: false, raw_labels: appRaw } } as any,
    tenantOverrides: tenantRaw ? { raw_labels: { web: tenantRaw } } : undefined,
  });
}

const OWN = 'traefik.http.routers.myapp-t1-web';

describe('raw label ownership at generation time', () => {
  it('keeps labels addressing the tenant\'s own router, service and middleware prefix', () => {
    const labels = labelsFor({
      [`${OWN}.priority`]: '5',
      'traefik.http.services.myapp-t1-web.loadbalancer.sticky.cookie': 'true',
      'traefik.http.middlewares.myapp-t1-web-extra.compress': 'true',
      'custom.thing': 'x',
    });
    expect(labels).toContain(`${OWN}.priority=5`);
    expect(labels).toContain('traefik.http.services.myapp-t1-web.loadbalancer.sticky.cookie=true');
    expect(labels).toContain('traefik.http.middlewares.myapp-t1-web-extra.compress=true');
    expect(labels).toContain('custom.thing=x');
  });

  it('drops tcp/udp, other routers, other services and other middlewares', () => {
    const bad = {
      'traefik.tcp.routers.db.rule': 'HostSNI(`*`)',
      'traefik.tcp.services.db.loadbalancer.server.port': '3306',
      'traefik.udp.routers.dns.entrypoints': 'dns',
      'traefik.http.routers.myapp-t2-web.priority': '1',
      'traefik.http.routers.admin.middlewares': 'x',
      'traefik.http.services.myapp-t2-web.loadbalancer.server.port': '1',
      'traefik.http.middlewares.other.compress': 'true',
      'traefik.http.middlewares.myapp-t2-web-x.compress': 'true',
      'traefik.http.serverstransports.t.insecureskipverify': 'true',
      'traefik.something': 'x',
    };
    const labels = labelsFor(bad, bad);
    const joined = labels.join('\n');
    for (const k of Object.keys(bad)) expect(joined).not.toContain(`${k}=`);
  });

  it('drops indexed spellings of reserved router keys', () => {
    const labels = labelsFor({
      [`${OWN}.entrypoints[0]`]: 'web',
      [`${OWN}.rule[0]`]: 'Host(`x`)',
      [`${OWN}.tls.domains[0].main`]: 'victim.example.com',
      [`${OWN}.tls.certresolver`]: 'other',
    });
    expect(labels.join('\n')).not.toMatch(/\[0\]|victim|certresolver=other/);
  });

  it('only lets the own router point at its own service', () => {
    const labels = labelsFor({ [`${OWN}.service`]: 'myapp-t2-web@docker' }, undefined);
    expect(labels.join('\n')).not.toContain('myapp-t2-web@docker');
    expect(labelsFor({ [`${OWN}.service`]: 'myapp-t1-web' })).toContain(`${OWN}.service=myapp-t1-web`);
  });
});

describe('rawLabelProblem / isBlockedRawLabelKey', () => {
  const tenantOwner = rawLabelOwnerForRouter('myapp-t1-web');

  it('names the reason for a non-conforming key', () => {
    expect(rawLabelProblem('traefik.tcp.routers.x.rule', 'v', tenantOwner)).toMatch(/tcp|udp/i);
    expect(rawLabelProblem('traefik.http.routers.other.priority', '1', tenantOwner)).toMatch(/own/i);
    expect(rawLabelProblem(`${OWN}.priority`, '1', tenantOwner)).toBeUndefined();
    expect(isBlockedRawLabelKey('traefik.http.routers.other.priority', tenantOwner)).toBe(true);
  });

  it('app-level owner matches the per-tenant name pattern for the service only', () => {
    const owner = rawLabelOwnerForAppService('myapp', 'web');
    expect(rawLabelProblem('traefik.http.routers.myapp-t9-web.priority', '1', owner)).toBeUndefined();
    expect(rawLabelProblem('traefik.http.routers.myapp-t9-api.priority', '1', owner)).toBeDefined();
    expect(rawLabelProblem('traefik.http.routers.zzz-t9-web.priority', '1', owner)).toBeDefined();
  });
});

describe('Overwatch admin raw labels', () => {
  it('drops tcp labels and foreign routers but keeps the admin router', () => {
    const yml = buildOverwatchComposeYml({
      project: { name: 'T', prefix: 't' },
      database: { type: 'mariadb', host: 'x', port: 3306, root_user: 'root', root_password_env: 'X', container_name: 'x' },
      networking: { external_network: 'n', apps_path: '/a' },
      traefik: { log_level: 'INFO', tls_termination: 'upstream', overwatch: { host: 'ow.example.com', raw_labels: {
        'traefik.tcp.routers.evil.rule': 'HostSNI(`*`)',
        'traefik.http.routers.tenant-x.priority': '9',
        'traefik.http.routers.admin.priority': '7',
      } } },
    } as any);
    expect(yml).not.toContain('traefik.tcp.routers.evil');
    expect(yml).not.toContain('tenant-x');
    expect(yml).toContain('traefik.http.routers.admin.priority=7');
  });
});

describe('save-time helpers', () => {
  it('assertAppRawLabelsOwned rejects with a message naming the key and accepts per-tenant own names', () => {
    const svc = (raw: Record<string, string>) => [{ name: 'web', routing: { raw_labels: raw } }];
    expect(() => assertAppRawLabelsOwned('myapp', svc({ 'traefik.udp.routers.d.rule': 'x' }))).toThrow(/traefik\.udp\.routers\.d\.rule/);
    expect(() => assertAppRawLabelsOwned('myapp', svc({ 'traefik.http.routers.admin.priority': '1' }))).toThrow(/admin/);
    expect(() => assertAppRawLabelsOwned('myapp', svc({ 'traefik.http.routers.myapp-t1-web.priority': '1' }))).not.toThrow();
    expect(() => assertAppRawLabelsOwned('myapp', undefined)).not.toThrow();
  });

  it('assertTenantRawLabelsOwned checks each service against its own router', () => {
    expect(() => assertTenantRawLabelsOwned('myapp', 't1', { api: { 'traefik.http.routers.myapp-t1-web.priority': '1' } })).toThrow(/myapp-t1-web/);
    expect(() => assertTenantRawLabelsOwned('myapp', 't1', { api: { 'traefik.http.routers.myapp-t1-api.priority': '1' } })).not.toThrow();
  });
});

describe('middleware ownership is not a bare prefix match', () => {
  const mw = (n: string) => `traefik.http.middlewares.${n}.compress`;
  it('tenant t1 cannot address middlewares of tenant t1-web-x (hyphenated slugs)', () => {
    const owner = rawLabelOwnerForRouter('shop-t1-web');
    expect(rawLabelProblem(mw('shop-t1-web-x-web-rl'), 'true', owner)).toBeDefined();
    expect(rawLabelProblem(mw('shop-t1-web-rate-limit'), 'true', owner)).toBeDefined();
    expect(rawLabelProblem(mw('shop-t1-web'), 'true', owner)).toBeDefined();
    expect(rawLabelProblem(mw('shop-t1-web-rate_limit'), 'true', owner)).toBeUndefined();
    expect(rawLabelProblem(mw('shop-t1-web-extra'), 'true', owner)).toBeUndefined();
  });
  it('app shop cannot address middlewares of app shop-t1', () => {
    const owner = rawLabelOwnerForRouter('shop-t1-web');
    expect(rawLabelProblem(mw('shop-t1-x-web-rl'), 'true', owner)).toBeDefined();
    const appOwner = rawLabelOwnerForAppService('shop', 'web');
    expect(rawLabelProblem(mw('shop-t9-web-rl'), 'true', appOwner)).toBeUndefined();
    expect(rawLabelProblem(mw('shop-t9-web-rate-limit'), 'true', appOwner)).toBeDefined();
    expect(rawLabelProblem(mw('shop-t9-api-rl'), 'true', appOwner)).toBeDefined();
    expect(rawLabelProblem(mw('other-t9-web-rl'), 'true', appOwner)).toBeDefined();
  });
  it('generation drops a hyphenated-suffix middleware label', () => {
    const labels = labelsFor({
      'traefik.http.middlewares.myapp-t1-web-x-web-rl.compress': 'true',
      'traefik.http.middlewares.myapp-t1-web-own_one.compress': 'true',
    });
    expect(labels.join('\n')).not.toContain('x-web-rl');
    expect(labels).toContain('traefik.http.middlewares.myapp-t1-web-own_one.compress=true');
  });
});

describe('own service backend url', () => {
  it('denies loadbalancer server url but keeps port and sticky options', () => {
    const labels = labelsFor({
      'traefik.http.services.myapp-t1-web.loadbalancer.server.url': 'http://overwatch:3002',
      'traefik.http.services.myapp-t1-web.loadbalancer.servers[0].url': 'http://10.0.0.1',
      'traefik.http.services.myapp-t1-web.loadbalancer.server.scheme': 'https',
      'traefik.http.services.myapp-t1-web.loadbalancer.sticky.cookie': 'true',
    });
    const joined = labels.join('\n');
    expect(joined).not.toMatch(/\.url=/);
    expect(labels).toContain('traefik.http.services.myapp-t1-web.loadbalancer.server.scheme=https');
    expect(labels).toContain('traefik.http.services.myapp-t1-web.loadbalancer.sticky.cookie=true');
  });
});

describe('own service: only plain loadbalancer options', () => {
  const S = 'traefik.http.services.myapp-t1-web';
  it('drops weighted/mirroring/failover naming a foreign service and serverstransport', () => {
    const bad = {
      [`${S}.weighted.services[0].name`]: 'myapp-t2-web@docker',
      [`${S}.mirroring.service`]: 'myapp-t2-web@docker',
      [`${S}.failover.service`]: 'myapp-t2-web@docker',
      [`${S}.loadbalancer.serverstransport`]: 'victim@file',
    };
    const joined = labelsFor(bad).join('\n');
    expect(joined).not.toMatch(/weighted|mirroring|failover|serverstransport|myapp-t2-web/);
    for (const [k, v] of Object.entries(bad)) {
      expect(() => assertTenantRawLabelsOwned('myapp', 't1', { web: { [k]: v } })).toThrow(k);
      expect(() => assertAppRawLabelsOwned('myapp', [{ name: 'web', routing: { raw_labels: { [k]: v } } }])).toThrow(k);
    }
  });
  it('keeps port, scheme, sticky, healthcheck and passhostheader', () => {
    const ok = {
      [`${S}.loadbalancer.server.port`]: '8080',
      [`${S}.loadbalancer.server.scheme`]: 'https',
      [`${S}.loadbalancer.sticky.cookie`]: 'true',
      [`${S}.loadbalancer.healthcheck.path`]: '/h',
      [`${S}.loadbalancer.passhostheader`]: 'false',
    };
    const labels = labelsFor(ok);
    for (const [k, v] of Object.entries(ok)) expect(labels).toContain(`${k}=${v}`);
  });
});

describe('own middleware types and router attachments', () => {
  const M = 'traefik.http.middlewares.myapp-t1-web-x';
  const R = 'traefik.http.routers.myapp-t1-web';

  it('denies middleware types that can address another service, a URL or a file', () => {
    const bad = {
      [`${M}.errors.service`]: 'myapp-t2-web@docker',
      [`${M}.errors.status`]: '200-599',
      [`${M}.errors.query`]: '/',
      [`${M}.forwardauth.address`]: 'http://internal',
      [`${M}.chain.middlewares`]: 'victim@docker',
      [`${M}.plugin.foo.bar`]: 'x',
      [`${M}.basicauth.usersfile`]: '/etc/passwd',
      [`${M}.digestauth.usersfile`]: '/etc/passwd',
      [`${M}.ratelimit.redis.endpoints`]: 'internal:6379',
      [`${M}.somethingnew.x`]: 'y',
    };
    const owner = rawLabelOwnerForRouter('myapp-t1-web');
    for (const [k, v] of Object.entries(bad)) expect(rawLabelProblem(k, v, owner), k).toBeDefined();
    const joined = labelsFor(bad).join('\n');
    expect(joined).not.toMatch(/errors|forwardauth|chain|plugin|usersfile|redis|somethingnew/);
    for (const [k, v] of Object.entries(bad)) {
      expect(() => assertTenantRawLabelsOwned('myapp', 't1', { web: { [k]: v } })).toThrow(k);
    }
  });

  it('keeps benign own middlewares', () => {
    const ok = {
      [`${M}.headers.customresponseheaders.X-Frame`]: 'DENY',
      [`${M}.ratelimit.average`]: '100',
      [`${M}.redirectscheme.scheme`]: 'https',
      [`${M}.stripprefix.prefixes`]: '/api',
      [`${M}.basicauth.users`]: 'u:$apr1$abc',
      [`${M}.basicauth.realm`]: 'r',
      [`${M}.ipallowlist.sourcerange`]: '10.0.0.0/8',
      [`${M}.compress`]: 'true',
    };
    const labels = labelsFor(ok);
    for (const [k, v] of Object.entries(ok)) {
      expect(rawLabelProblem(k, v, rawLabelOwnerForRouter('myapp-t1-web')), k).toBeUndefined();
      expect(labels).toContain(`${k}=${v}`);
    }
  });

  it('only lets the own router attach own or generated middlewares', () => {
    const owner = rawLabelOwnerForRouter('myapp-t1-web');
    const p = (v: string) => rawLabelProblem(`${R}.middlewares`, v, owner);
    expect(p('myapp-t2-web-x@docker')).toBeDefined();
    expect(p('foo@file')).toBeDefined();
    expect(p('api@internal')).toBeDefined();
    expect(p('myapp-t1-web-x@docker,foo@file')).toBeDefined();
    expect(p('myapp-t1-web-x')).toBeUndefined();
    expect(p('myapp-t1-web-x@docker, myapp-t1-web-y_z')).toBeUndefined();
    expect(labelsFor({ [`${R}.middlewares`]: 'foo@file' }).join('\n')).not.toContain('foo@file');
    expect(() => assertTenantRawLabelsOwned('myapp', 't1', { web: { [`${R}.middlewares`]: 'foo@file' } })).toThrow(/middlewares/);
    expect(() => assertAppRawLabelsOwned('myapp', [{ name: 'web', routing: { raw_labels: { [`${R}.middlewares`]: 'myapp-t1-web-x@docker' } } }])).not.toThrow();
    expect(() => assertAppRawLabelsOwned('myapp', [{ name: 'web', routing: { raw_labels: { [`${R}.middlewares`]: 'foo@file' } } }])).toThrow(/middlewares/);
  });

  it('allows the generator\'s own typed middleware names in a router list', () => {
    const owner = { ...rawLabelOwnerForRouter('myapp-t1-web'), isGeneratedMiddleware: (n: string) => n === 'myapp-t1-web-rate-limit' };
    expect(rawLabelProblem(`${R}.middlewares`, 'myapp-t1-web-rate-limit@docker', owner)).toBeUndefined();
    expect(rawLabelProblem(`${R}.middlewares`, 'myapp-t1-web-other-one', owner)).toBeDefined();
  });

  it('accepts hyphenated typed middleware names at app save, exactly as generation does', () => {
    const save = (value: string) => () => assertAppRawLabelsOwned('myapp', [
      { name: 'web', routing: { raw_labels: { [`${R}.middlewares`]: value } } },
    ]);
    expect(save('myapp-t1-web-rate-limit')).not.toThrow();
    expect(save('myapp-t1-web-rate-limit@docker, myapp-t1-web-sec-headers-strict')).not.toThrow();
    expect(save('myapp-t1-web-_stripprefix')).not.toThrow();
    // Still refused: foreign tenant-agnostic names, other apps, other services, @file/@internal.
    expect(save('otherapp-t1-web-rate-limit')).toThrow(/middlewares/);
    expect(save('myapp-t1-api-rate-limit')).toThrow(/middlewares/);
    expect(save('myapp-t1-web-rate-limit,foo@file')).toThrow(/middlewares/);
    // Same rule for a tenant's own raw labels.
    const tenant = (value: string) => () => assertTenantRawLabelsOwned('myapp', 't1', { web: { [`${R}.middlewares`]: value } });
    expect(tenant('myapp-t1-web-rate-limit@docker')).not.toThrow();
    expect(tenant('myapp-t2-web-rate-limit')).toThrow(/middlewares/);
    expect(tenant('foo@file')).toThrow(/middlewares/);
    expect(save('rate-limit@file')).toThrow(/middlewares/);
    expect(save('api@internal')).toThrow(/middlewares/);
  });

  it('keeps generation-time exact: a hyphenated name the router did not generate is dropped', () => {
    const typed = buildTraefikLabels({
      app: { ...app, traefik: { middlewares: { 'rate-limit': { type: 'rateLimit', average: 5 } } } } as any,
      tenantId: 't1', domain: 't1.app.example.com', certResolverName: 'cf',
      service: { name: 'web', required: true, is_init_container: false, ports: { internal: 80 },
        routing: { enabled: true, strip_prefix: false, middlewares: ['rate-limit'],
          raw_labels: { [`${R}.middlewares`]: 'myapp-t1-web-rate-limit,myapp-t1-web-nope-nope' } } } as any,
    });
    expect(typed.join('\n')).not.toContain('myapp-t1-web-nope-nope');
  });

  it('denies router tls options and other tls fields', () => {
    const owner = rawLabelOwnerForRouter('myapp-t1-web');
    expect(rawLabelProblem(`${R}.tls.options`, 'victim@file', owner)).toBeDefined();
    expect(rawLabelProblem(`${R}.tls.options`, 'x', owner)).toBeDefined();
    expect(labelsFor({ [`${R}.tls.options`]: 'x' }).join('\n')).not.toContain('tls.options');
  });

  it('keeps the admin router unrestricted (operator-owned)', () => {
    const yml = buildOverwatchComposeYml({
      database: { type: 'mariadb', host: 'x', port: 3306, root_user: 'root', root_password_env: 'X', container_name: 'x' },
      networking: { external_network: 'n', apps_path: '/a' },
      traefik: { log_level: 'INFO', tls_termination: 'upstream', overwatch: { host: 'ow.example.com', raw_labels: {
        'traefik.http.middlewares.sso.forwardauth.address': 'http://auth',
        'traefik.http.routers.admin.middlewares': 'sso@docker',
      } } },
    } as any);
    expect(yml).toContain('forwardauth.address=http://auth');
  });
});
