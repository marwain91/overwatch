import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let appsDir: string;
let tmpRoot: string;
let cfg: any;

async function addTenant(appId: string, tenantId: string, domain: string, aliases?: string[]) {
  const dir = path.join(appsDir, appId, 'tenants', tenantId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '.env'), `TENANT_ID=${tenantId}\nTENANT_DOMAIN=${domain}\n`);
  if (aliases) await fs.writeFile(path.join(dir, 'traefik.yaml'), yaml.dump({ host_aliases: aliases }));
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-alias-'));
  appsDir = path.join(tmpRoot, 'apps');
  await fs.mkdir(appsDir, { recursive: true });
  cfg = {
    project: { name: 'T', prefix: 'test', db_prefix: 'test' },
    traefik: { log_level: 'INFO', overwatch: { host: 'ow.example.com' }, dashboard: { enabled: true, host: 'dash.example.com' } },
    mcp: { enabled: true, public_url: 'https://mcp.example.com/' },
  };
  vi.doMock('../config', () => ({ getAppsDir: () => appsDir, getDataDir: () => tmpRoot, loadConfig: () => cfg }));
  vi.doMock('../config/loader', () => ({ getAppsDir: () => appsDir, loadConfig: () => cfg }));
  vi.doMock('../services/fileLock', () => ({ withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn() }));
  vi.doMock('../services/app', () => ({
    getApp: async (id: string) => (id === 'shop'
      ? { id: 'shop', domain_template: '*.shop.example.com', services: [{ name: 'web' }] }
      : id === 'fixed' ? { id: 'fixed', domain_template: 'fixed.example.com', services: [{ name: 'web' }] } : null),
    applyApp: async () => ({}),
  }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  vi.resetModules();
  vi.restoreAllMocks();
  for (const m of ['../config', '../config/loader', '../services/fileLock', '../services/app']) vi.doUnmock(m);
});

describe('updateTenantTraefik host_aliases validation', () => {
  it('accepts aliases inside the wildcard template', async () => {
    await addTenant('shop', 't1', 't1.shop.example.com');
    const { updateTenantTraefik } = await import('../services/traefikConfig');
    const out = await updateTenantTraefik('shop', 't1', { host_aliases: ['Legacy.shop.example.com'] });
    expect(out?.host_aliases).toEqual(['legacy.shop.example.com']);
  });

  it.each([
    ['not a hostname', 'bad host!'],
    ['the Overwatch host', 'ow.example.com'],
    ['the mcp public host', 'mcp.example.com'],
    ['the dashboard host', 'dash.example.com'],
    ['another tenant domain', 't2.shop.example.com'],
    ['another tenant alias', 'shared.shop.example.com'],
    ['a host outside the wildcard template', 'www.other.org'],
  ])('rejects %s with ValidationError naming the alias', async (_n, alias) => {
    await addTenant('shop', 't1', 't1.shop.example.com');
    await addTenant('shop', 't2', 't2.shop.example.com', ['shared.shop.example.com']);
    cfg.traefik.overwatch.host = 'ow.example.com';
    const { updateTenantTraefik } = await import('../services/traefikConfig');
    const { ValidationError } = await import('../utils/httpErrors');
    const p = updateTenantTraefik('shop', 't1', { host_aliases: [alias] });
    await expect(p).rejects.toBeInstanceOf(ValidationError);
    await expect(p).rejects.toThrow(alias);
  });

  it('rejects a domain owned by a tenant of another app', async () => {
    await addTenant('shop', 't1', 't1.shop.example.com');
    await addTenant('other', 'x', 'x.shop.example.com');
    const { updateTenantTraefik } = await import('../services/traefikConfig');
    await expect(updateTenantTraefik('shop', 't1', { host_aliases: ['x.shop.example.com'] })).rejects.toThrow(/x\.shop\.example\.com/);
  });

  it('allows an outside host only through traefik.allowed_alias_domains', async () => {
    await addTenant('shop', 't1', 't1.shop.example.com');
    cfg.traefik.allowed_alias_domains = ['partner.org'];
    const { updateTenantTraefik } = await import('../services/traefikConfig');
    await expect(updateTenantTraefik('shop', 't1', { host_aliases: ['www.partner.org', 'partner.org'] })).resolves.toBeDefined();
    await expect(updateTenantTraefik('shop', 't1', { host_aliases: ['notpartner.org'] })).rejects.toThrow(/notpartner\.org/);
  });

  it('does not apply the template restriction to a non-wildcard domain_template', async () => {
    await addTenant('fixed', 't1', 'fixed.example.com');
    const { updateTenantTraefik } = await import('../services/traefikConfig');
    await expect(updateTenantTraefik('fixed', 't1', { host_aliases: ['www.anything.org'] })).resolves.toBeDefined();
    await expect(updateTenantTraefik('fixed', 't1', { host_aliases: ['ow.example.com'] })).rejects.toThrow(/ow\.example\.com/);
  });
});

describe('alias checks fail closed', () => {
  it('save-time: an unloadable config is an exposed error, not an allow', async () => {
    await addTenant('shop', 't1', 't1.shop.example.com');
    cfg = undefined;
    vi.doMock('../config/loader', () => ({ getAppsDir: () => appsDir, loadConfig: () => { throw new Error('boom'); } }));
    const { updateTenantTraefik } = await import('../services/traefikConfig');
    await expect(updateTenantTraefik('shop', 't1', { host_aliases: ['a.shop.example.com'] })).rejects.toMatchObject({ expose: true });
  });

  it('save-time: a missing app is an error, not an unrestricted allow', async () => {
    await addTenant('ghost', 't1', 't1.ghost.example.com');
    const { updateTenantTraefik } = await import('../services/traefikConfig');
    await expect(updateTenantTraefik('ghost', 't1', { host_aliases: ['www.anything.org'] })).rejects.toMatchObject({ expose: true });
  });

  it('generation-time: aliases are all dropped with a warning when the context cannot be built', async () => {
    await addTenant('ghost', 't1', 't1.ghost.example.com', ['www.anything.org']);
    const { readTenantTraefik } = await import('../services/tenantTraefik');
    expect((await readTenantTraefik('ghost', 't1'))?.host_aliases).toEqual([]);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('updateTenantTraefik raw_labels validation', () => {
  it('rejects a foreign router label with ValidationError naming the key', async () => {
    await addTenant('shop', 't1', 't1.shop.example.com');
    const { updateTenantTraefik } = await import('../services/traefikConfig');
    const { ValidationError } = await import('../utils/httpErrors');
    const p = updateTenantTraefik('shop', 't1', { raw_labels: { web: { 'traefik.http.routers.shop-t2-web.priority': '1' } } });
    await expect(p).rejects.toBeInstanceOf(ValidationError);
    await expect(p).rejects.toThrow('traefik.http.routers.shop-t2-web.priority');
    await expect(updateTenantTraefik('shop', 't1', { raw_labels: { web: { 'traefik.tcp.routers.x.service': 'y' } } })).rejects.toThrow(/traefik\.tcp\.routers\.x\.service/);
  });

  it('accepts own-router labels', async () => {
    await addTenant('shop', 't1', 't1.shop.example.com');
    const { updateTenantTraefik } = await import('../services/traefikConfig');
    const out = await updateTenantTraefik('shop', 't1', { raw_labels: { web: { 'traefik.http.routers.shop-t1-web.priority': '3' } } });
    expect(out?.raw_labels?.web).toBeDefined();
  });
});

describe('readTenantTraefik generation-time re-check', () => {
  it('drops aliases that are no longer allowed, with a warning, and keeps the rest', async () => {
    await addTenant('shop', 't1', 't1.shop.example.com', ['ow.example.com', 'ok.shop.example.com', 't2.shop.example.com']);
    await addTenant('shop', 't2', 't2.shop.example.com');
    const { readTenantTraefik } = await import('../services/tenantTraefik');
    const out = await readTenantTraefik('shop', 't1');
    expect(out?.host_aliases).toEqual(['ok.shop.example.com']);
    expect(console.warn).toHaveBeenCalled();
    expect(String((console.warn as any).mock.calls[0][0])).toContain('ow.example.com');
  });

  it('getTenantTraefik still shows the stored aliases', async () => {
    await addTenant('shop', 't1', 't1.shop.example.com', ['ow.example.com']);
    const { getTenantTraefik } = await import('../services/traefikConfig');
    expect((await getTenantTraefik('shop', 't1'))?.host_aliases).toEqual(['ow.example.com']);
  });
});
