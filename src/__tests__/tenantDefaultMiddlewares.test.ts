import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { AppDefinition } from '../models/app';
import type { TraefikGlobal, TraefikTenant } from '../models/traefik';

// Global default_middlewares are the admin's: tenant overrides and tenant raw
// labels (editor-writable) may change the app/service part of a router's chain
// but neither drop nor redefine the global defaults.

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const GLOBAL: TraefikGlobal = {
  log_level: 'INFO',
  middlewares: {
    gate: { type: 'basicAuth', users: ['ops:$apr1$global'] },
    corp: { type: 'ipAllowList', source_range: ['10.0.0.0/8'] },
    secure: { type: 'chain', middlewares: ['corp'] },
    strict: { type: 'rateLimit', average: 10 },
  },
  default_middlewares: ['gate', 'secure'],
};

const app = {
  id: 'myapp', name: 'MyApp', domain_template: '*.app.example.com',
  registry: { type: 'ghcr', url: 'ghcr.io', repository: 'ns/myapp', auth: { type: 'token' } },
  services: [], default_image_tag: 'latest',
  traefik: { middlewares: { appmw: { type: 'compress' } }, default_middlewares: ['appmw'] },
} as unknown as AppDefinition;

const R = 'traefik.http.routers.myapp-t1-web';
const M = 'traefik.http.middlewares.myapp-t1-web';

async function labelsFor(tenant: TraefikTenant | undefined, svcMiddlewares?: string[]) {
  const { buildTraefikLabels } = await import('../services/traefikLabels');
  return buildTraefikLabels({
    app, tenantId: 't1', domain: 't1.app.example.com', certResolverName: 'cf', traefik: GLOBAL,
    service: { name: 'web', required: true, is_init_container: false, ports: { internal: 80 },
      routing: { enabled: true, strip_prefix: false, middlewares: svcMiddlewares } } as any,
    tenantOverrides: tenant,
  });
}
const routerMiddlewares = (labels: string[]) => labels.filter(l => l.startsWith(`${R}.middlewares=`));

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

describe('middleware_overrides keep the global defaults', () => {
  it('replaces only the app and service part of the chain', async () => {
    const labels = await labelsFor({ middleware_overrides: { web: ['strict'] } }, ['appsvc']);
    expect(routerMiddlewares(labels)).toEqual([
      `${R}.middlewares=myapp-t1-web-gate,myapp-t1-web-secure,myapp-t1-web-strict`,
    ]);
    expect(labels.join('\n')).not.toMatch(/appmw|appsvc/);
  });

  it('an empty override leaves just the global defaults', async () => {
    const labels = await labelsFor({ middleware_overrides: { web: [] } });
    expect(routerMiddlewares(labels)).toEqual([`${R}.middlewares=myapp-t1-web-gate,myapp-t1-web-secure`]);
  });
});

describe('tenant raw labels cannot drop or redefine the global defaults', () => {
  it('drops a router middlewares label that leaves out a global default', async () => {
    const labels = await labelsFor({ raw_labels: { web: { [`${R}.middlewares`]: 'myapp-t1-web-own_x' } } });
    expect(routerMiddlewares(labels)).toEqual([`${R}.middlewares=myapp-t1-web-gate,myapp-t1-web-secure,myapp-t1-web-appmw`]);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/global default/);
  });

  it('keeps one that lists them all', async () => {
    const value = 'myapp-t1-web-gate@docker,myapp-t1-web-secure,myapp-t1-web-own_x';
    const labels = await labelsFor({ raw_labels: { web: { [`${R}.middlewares`]: value } } });
    expect(labels).toContain(`${R}.middlewares=${value}`);
  });

  it('drops labels that rewrite a global default middleware, chain members included', async () => {
    const labels = await labelsFor({ raw_labels: { web: {
      [`${M}-gate.basicauth.users`]: 'mallory:$apr1$x',
      [`${M}-CORP.ipallowlist.sourcerange`]: '0.0.0.0/0',
      [`${M}-own_x.compress`]: 'true',
    } } });
    const joined = labels.join('\n');
    expect(joined).not.toMatch(/mallory|=0\.0\.0\.0\/0/);
    expect(joined).toContain(`${M}-gate.basicauth.users=ops:$apr1$global`);
    expect(labels).toContain(`${M}-own_x.compress=true`);
  });

  it('app-level raw labels (admin-owned) are not affected', async () => {
    const { buildTraefikLabels } = await import('../services/traefikLabels');
    const labels = buildTraefikLabels({
      app, tenantId: 't1', domain: 't1.app.example.com', certResolverName: 'cf', traefik: GLOBAL,
      service: { name: 'web', required: true, is_init_container: false, ports: { internal: 80 },
        routing: { enabled: true, strip_prefix: false, raw_labels: { [`${R}.middlewares`]: 'myapp-t1-web-own_x' } } } as any,
    });
    expect(labels).toContain(`${R}.middlewares=myapp-t1-web-own_x`);
  });
});

describe('save time (PUT /api/apps/:id/tenants/:tid/traefik)', () => {
  let tmpRoot: string;
  let appsDir: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-tenant-defaults-'));
    appsDir = path.join(tmpRoot, 'apps');
    const dir = path.join(appsDir, 'myapp', 'tenants', 't1');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, '.env'), 'TENANT_ID=t1\nTENANT_DOMAIN=t1.app.example.com\n');
    const cfg = { project: { name: 'T', prefix: 'test', db_prefix: 'test' }, traefik: GLOBAL };
    vi.doMock('../config', () => ({ getAppsDir: () => appsDir, getDataDir: () => tmpRoot, loadConfig: () => cfg }));
    vi.doMock('../config/loader', () => ({ getAppsDir: () => appsDir, loadConfig: () => cfg }));
    vi.doMock('../services/fileLock', () => ({ withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn() }));
    vi.doMock('../services/app', () => ({ getApp: async () => app, applyApp: async () => ({}) }));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    for (const m of ['../config', '../config/loader', '../services/fileLock', '../services/app']) vi.doUnmock(m);
  });

  it.each([
    ['a router middlewares list without the defaults', { [`${R}.middlewares`]: 'myapp-t1-web-own_x' }, /global default/],
    ['a label rewriting a default middleware', { [`${M}-gate.basicauth.users`]: 'mallory:$apr1$x' }, /global default/],
    ['a label rewriting a chain member of a default', { [`${M}-corp.ipallowlist.sourcerange`]: '0.0.0.0/0' }, /global default/],
  ])('refuses %s with a 400', async (_n, labels, msg) => {
    const { updateTenantTraefik } = await import('../services/traefikConfig');
    const { ValidationError } = await import('../utils/httpErrors');
    const p = updateTenantTraefik('myapp', 't1', { raw_labels: { web: labels } });
    await expect(p).rejects.toBeInstanceOf(ValidationError);
    await expect(p).rejects.toThrow(msg);
  });

  it('accepts a list that keeps them, and any middleware_overrides', async () => {
    const { updateTenantTraefik } = await import('../services/traefikConfig');
    const body = {
      middleware_overrides: { web: ['strict'] },
      raw_labels: { web: { [`${R}.middlewares`]: 'myapp-t1-web-gate,myapp-t1-web-secure,myapp-t1-web-own_x' } },
    };
    await expect(updateTenantTraefik('myapp', 't1', body)).resolves.toMatchObject(body);
  });
});
