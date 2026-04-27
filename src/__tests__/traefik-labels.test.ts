import { describe, it, expect } from 'vitest';
import { buildTraefikLabels, resolveTlsTermination } from '../services/traefikLabels';
import type { AppDefinition, AppService } from '../models/app';
import type { TraefikGlobal, TraefikTenant } from '../models/traefik';

function baseApp(traefikOverride?: Partial<AppDefinition['traefik']>): AppDefinition {
  return {
    id: 'myapp',
    name: 'MyApp',
    domain_template: '*.app.example.com',
    registry: { type: 'ghcr', url: 'ghcr.io', repository: 'ns/myapp', auth: { type: 'token' } },
    services: [],
    default_image_tag: 'latest',
    traefik: traefikOverride as any,
    createdAt: '2026-04-27T00:00:00Z',
    updatedAt: '2026-04-27T00:00:00Z',
  } as AppDefinition;
}

const baseService = {
  name: 'web',
  required: true,
  is_init_container: false,
  ports: { internal: 3000 },
  routing: { enabled: true, strip_prefix: false },
} as const;

describe('buildTraefikLabels', () => {
  it('emits Host(), TLS, and service port for a basic service', () => {
    const labels = buildTraefikLabels({
      app: baseApp(),
      tenantId: 't1',
      domain: 't1.app.example.com',
      service: baseService as any,
      certResolverName: 'cf-prod',
    });
    const joined = labels.join('\n');
    expect(joined).toMatch(/traefik\.enable=true/);
    expect(joined).toMatch(/traefik\.http\.routers\.myapp-t1-web\.rule=Host\(`t1\.app\.example\.com`\)/);
    expect(joined).toMatch(/traefik\.http\.routers\.myapp-t1-web\.tls=true/);
    expect(joined).toMatch(/traefik\.http\.routers\.myapp-t1-web\.tls\.certresolver=cf-prod/);
    expect(joined).toMatch(/traefik\.http\.services\.myapp-t1-web\.loadbalancer\.server\.port=3000/);
  });

  it('includes host_aliases as alternative Host() matchers', () => {
    const tenant: TraefikTenant = { host_aliases: ['legacy.acme.com'] };
    const labels = buildTraefikLabels({
      app: baseApp(),
      tenantId: 't1',
      domain: 't1.app.example.com',
      service: baseService as any,
      certResolverName: 'cf-prod',
      tenantOverrides: tenant,
    });
    expect(labels.join('\n')).toMatch(/Host\(`t1\.app\.example\.com`\) \|\| Host\(`legacy\.acme\.com`\)/);
  });

  it('returns empty array for init containers', () => {
    const labels = buildTraefikLabels({
      app: baseApp(),
      tenantId: 't1',
      domain: 't1.app.example.com',
      service: { ...baseService, name: 'migrate', is_init_container: true } as any,
      certResolverName: 'cf-prod',
    });
    expect(labels).toEqual([]);
  });

  it('returns empty array when routing.enabled=false', () => {
    const labels = buildTraefikLabels({
      app: baseApp(),
      tenantId: 't1',
      domain: 't1.app.example.com',
      service: { ...baseService, routing: { enabled: false, strip_prefix: false } } as any,
      certResolverName: 'cf-prod',
    });
    expect(labels).toEqual([]);
  });

  it('emits typed middleware definition + router reference', () => {
    const traefik: TraefikGlobal = {
      log_level: 'INFO',
      middlewares: { 'rl': { type: 'rateLimit', average: 100, burst: 200 } },
    };
    const svc = { ...baseService, routing: { enabled: true, strip_prefix: false, middlewares: ['rl'] } };
    const labels = buildTraefikLabels({
      app: baseApp(),
      tenantId: 't1',
      domain: 't1.app.example.com',
      service: svc as any,
      certResolverName: 'cf-prod',
      traefik,
    });
    const joined = labels.join('\n');
    expect(joined).toMatch(/traefik\.http\.middlewares\.myapp-t1-web-rl\.ratelimit\.average=100/);
    expect(joined).toMatch(/traefik\.http\.middlewares\.myapp-t1-web-rl\.ratelimit\.burst=200/);
    expect(joined).toMatch(/traefik\.http\.routers\.myapp-t1-web\.middlewares=myapp-t1-web-rl/);
  });

  it('tenant middleware_overrides REPLACE the app chain', () => {
    const traefik: TraefikGlobal = {
      log_level: 'INFO',
      middlewares: {
        'app-default': { type: 'compress' },
        'tenant-strict': { type: 'rateLimit', average: 10 },
      },
    };
    const svc = { ...baseService, routing: { enabled: true, strip_prefix: false, middlewares: ['app-default'] } };
    const tenantOverrides: TraefikTenant = { middleware_overrides: { web: ['tenant-strict'] } };
    const labels = buildTraefikLabels({
      app: baseApp(),
      tenantId: 't1',
      domain: 't1.app.example.com',
      service: svc as any,
      certResolverName: 'cf-prod',
      traefik,
      tenantOverrides,
    });
    const joined = labels.join('\n');
    expect(joined).toMatch(/myapp-t1-web-tenant-strict/);
    expect(joined).not.toMatch(/myapp-t1-web-app-default/);
  });

  it('appends raw_labels (and skips denylisted keys silently)', () => {
    const svc = {
      ...baseService,
      routing: {
        enabled: true,
        strip_prefix: false,
        raw_labels: {
          'traefik.http.middlewares.custom.basicauth.users': 'user:hash',
          'traefik.enable': 'false', // denylisted — should be filtered out
        },
      },
    };
    const labels = buildTraefikLabels({
      app: baseApp(),
      tenantId: 't1',
      domain: 't1.app.example.com',
      service: svc as any,
      certResolverName: 'cf-prod',
    });
    const joined = labels.join('\n');
    expect(joined).toMatch(/traefik\.http\.middlewares\.custom\.basicauth\.users=user:hash/);
    // The traefik.enable=true line is emitted by us; the denylisted false attempt should not flip it.
    const enableMatches = joined.match(/traefik\.enable=/g) ?? [];
    expect(enableMatches.length).toBe(1);
    expect(joined).toMatch(/traefik\.enable=true/);
  });

  it('routes through the upstream entrypoint and skips TLS labels when termination=upstream', () => {
    const traefik: TraefikGlobal = {
      log_level: 'INFO',
      tls_termination: 'upstream',
      upstream_entrypoint: 'web',
    };
    const labels = buildTraefikLabels({
      app: baseApp(),
      tenantId: 't1',
      domain: 't1.app.example.com',
      service: baseService as any,
      certResolverName: 'cf-prod', // present but should be ignored
      traefik,
    });
    const joined = labels.join('\n');
    expect(joined).toMatch(/traefik\.http\.routers\.myapp-t1-web\.entrypoints=web/);
    expect(joined).not.toMatch(/traefik\.http\.routers\.myapp-t1-web\.tls=true/);
    expect(joined).not.toMatch(/certresolver/);
  });

  it('per-service tls_termination overrides the global default', () => {
    const traefik: TraefikGlobal = { log_level: 'INFO', tls_termination: 'traefik' };
    const svc: AppService = {
      ...baseService,
      routing: { enabled: true, strip_prefix: false, tls_termination: 'upstream' },
    } as any;
    const labels = buildTraefikLabels({
      app: baseApp(),
      tenantId: 't1',
      domain: 't1.app.example.com',
      service: svc,
      certResolverName: 'cf-prod',
      traefik,
    });
    const joined = labels.join('\n');
    expect(joined).toMatch(/traefik\.http\.routers\.myapp-t1-web\.entrypoints=web/);
    expect(joined).not.toMatch(/tls=true/);
  });

  it('per-tenant tls_termination overrides the per-service setting', () => {
    const traefik: TraefikGlobal = { log_level: 'INFO', tls_termination: 'traefik' };
    const svc: AppService = {
      ...baseService,
      routing: { enabled: true, strip_prefix: false, tls_termination: 'traefik' },
    } as any;
    const tenant: TraefikTenant = { tls_termination: 'upstream' };
    const labels = buildTraefikLabels({
      app: baseApp(),
      tenantId: 't1',
      domain: 't1.app.example.com',
      service: svc,
      certResolverName: 'cf-prod',
      traefik,
      tenantOverrides: tenant,
    });
    const joined = labels.join('\n');
    expect(joined).toMatch(/entrypoints=web/);
    expect(joined).not.toMatch(/tls=true/);
  });

  it('honors a custom upstream_entrypoint name', () => {
    const traefik: TraefikGlobal = { log_level: 'INFO', tls_termination: 'upstream', upstream_entrypoint: 'edge' };
    const labels = buildTraefikLabels({
      app: baseApp(),
      tenantId: 't1',
      domain: 't1.app.example.com',
      service: baseService as any,
      certResolverName: 'cf-prod',
      traefik,
    });
    expect(labels.join('\n')).toMatch(/entrypoints=edge/);
  });
});

describe('resolveTlsTermination', () => {
  const baseSvc: AppService = {
    name: 'web', required: true, is_init_container: false, ports: { internal: 3000 },
    routing: { enabled: true, strip_prefix: false },
  } as any;

  it('defaults to "traefik" when nothing is set', () => {
    expect(resolveTlsTermination(baseSvc, undefined, undefined)).toBe('traefik');
  });

  it('uses global default when nothing else is set', () => {
    expect(resolveTlsTermination(baseSvc, { log_level: 'INFO', tls_termination: 'upstream' }, undefined)).toBe('upstream');
  });

  it('service overrides global', () => {
    const svc = { ...baseSvc, routing: { enabled: true, strip_prefix: false, tls_termination: 'upstream' as const } } as any;
    expect(resolveTlsTermination(svc, { log_level: 'INFO', tls_termination: 'traefik' }, undefined)).toBe('upstream');
  });

  it('tenant overrides service', () => {
    const svc = { ...baseSvc, routing: { enabled: true, strip_prefix: false, tls_termination: 'upstream' as const } } as any;
    expect(resolveTlsTermination(svc, undefined, { tls_termination: 'traefik' })).toBe('traefik');
  });
});

describe('buildTraefikLabels (chain expansion regression)', () => {
  it('expands chain middleware references with router-scoped names', () => {
    const traefik: TraefikGlobal = {
      log_level: 'INFO',
      middlewares: {
        'auth-chain': { type: 'chain', middlewares: ['basic', 'ip'] },
        'basic': { type: 'basicAuth', users: ['admin:x'] },
        'ip': { type: 'ipAllowList', source_range: ['10.0.0.0/8'] },
      },
    };
    const svc = { ...baseService, routing: { enabled: true, strip_prefix: false, middlewares: ['auth-chain'] } };
    const labels = buildTraefikLabels({
      app: baseApp(),
      tenantId: 't1',
      domain: 't1.app.example.com',
      service: svc as any,
      certResolverName: 'cf-prod',
      traefik,
    });
    const joined = labels.join('\n');
    expect(joined).toMatch(/traefik\.http\.middlewares\.myapp-t1-web-auth-chain\.chain\.middlewares=myapp-t1-web-basic@docker,myapp-t1-web-ip@docker/);
    expect(joined).toMatch(/traefik\.http\.middlewares\.myapp-t1-web-basic\.basicauth\.users=admin:x/);
    expect(joined).toMatch(/traefik\.http\.middlewares\.myapp-t1-web-ip\.ipallowlist\.sourcerange=10\.0\.0\.0\/8/);
  });
});
