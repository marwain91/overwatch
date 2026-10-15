import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Host aliases are checked against every other tenant's domain and aliases. The
// check and the write must run under the same 'tenant-domains' lock tenant
// create uses, or two concurrent writes both pass and produce duplicate Host rules.

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let tmpRoot: string;
let appsDir: string;

async function addTenant(tenantId: string) {
  const dir = path.join(appsDir, 'shop', 'tenants', tenantId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '.env'), `TENANT_ID=${tenantId}\nTENANT_DOMAIN=${tenantId}.shop.example.com\n`);
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-alias-lock-'));
  appsDir = path.join(tmpRoot, 'apps');
  const cfg = { project: { name: 'T', prefix: 'test', db_prefix: 'test' }, traefik: { log_level: 'INFO' } };
  vi.doMock('../config', () => ({ getAppsDir: () => appsDir, getDataDir: () => tmpRoot, loadConfig: () => cfg }));
  vi.doMock('../config/loader', () => ({ getAppsDir: () => appsDir, loadConfig: () => cfg }));
  vi.doMock('../services/app', () => ({
    getApp: async () => ({ id: 'shop', domain_template: '*.shop.example.com', services: [{ name: 'web' }] }),
    applyApp: async () => ({}),
  }));
  await addTenant('t1');
  await addTenant('t2');
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  vi.resetModules();
  vi.restoreAllMocks();
  for (const m of ['../config', '../config/loader', '../services/app', '../services/fileLock']) vi.doUnmock(m);
});

describe('alias writes take the tenant-domains lock', () => {
  it('two tenants claiming the same alias at once: exactly one wins', async () => {
    const { updateTenantTraefik, getTenantTraefik } = await import('../services/traefikConfig');
    const results = await Promise.allSettled([
      updateTenantTraefik('shop', 't1', { host_aliases: ['shared.shop.example.com'] }),
      updateTenantTraefik('shop', 't2', { host_aliases: ['shared.shop.example.com'] }),
    ]);
    expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason?.message)).toMatch(/already used by another tenant/);
    const stored = [await getTenantTraefik('shop', 't1'), await getTenantTraefik('shop', 't2')];
    expect(stored.filter(t => t?.host_aliases?.includes('shared.shop.example.com'))).toHaveLength(1);
  });

  it('the check and the write run while tenant-domains is held', async () => {
    const held = new Set<string>();
    const seen: string[] = [];
    vi.doMock('../services/fileLock', () => ({
      withFileLock: async <T>(key: string, fn: () => Promise<T>) => {
        held.add(key);
        try { return await fn(); } finally { held.delete(key); }
      },
    }));
    vi.doMock('../services/tenantStore', async () => {
      const actual = await vi.importActual<any>('../services/tenantStore');
      return {
        ...actual,
        listTenantDirs: async (...args: any[]) => {
          seen.push(held.has('tenant-domains') ? 'check:locked' : 'check:unlocked');
          return actual.listTenantDirs(...args);
        },
      };
    });
    try {
      const { updateTenantTraefik } = await import('../services/traefikConfig');
      await updateTenantTraefik('shop', 't1', { host_aliases: ['legacy.shop.example.com'] });
      expect(seen).toEqual(['check:locked']);
    } finally {
      vi.doUnmock('../services/tenantStore');
    }
  });
});
