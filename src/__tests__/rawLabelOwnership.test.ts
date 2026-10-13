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
