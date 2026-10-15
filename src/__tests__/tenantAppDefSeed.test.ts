import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let root: string;
const getApp = vi.fn();

const appDef = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: id, domain_template: `*.${id}.example`,
  registry: { type: 'ghcr', url: 'ghcr.io', repository: `o/${id}`, auth: { type: 'token' } },
  services: [{ name: 'web', image_suffix: 'web', ports: { internal: 80 } }],
  default_image_tag: 'latest',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});
const snapshot = (app: string, tenant: string) => path.join(root, 'apps', app, 'tenants', tenant, 'app-definition.json');

async function mkTenant(app: string, tenant: string) {
  await fs.mkdir(path.join(root, 'apps', app, 'tenants', tenant), { recursive: true });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-seed-'));
  getApp.mockReset();
  vi.doMock('../config', () => ({ getAppsDir: () => path.join(root, 'apps'), getDataDir: () => path.join(root, 'data') }));
  vi.doMock('../services/app', () => ({ getApp }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('../config');
  vi.doUnmock('../services/app');
  vi.doUnmock('fs/promises');
  await fs.rm(root, { recursive: true, force: true });
});

describe('seedMissingTenantAppDefs', () => {
  it('seeds a snapshot (static shape, no timestamps) for a tenant without one', async () => {
    await mkTenant('shop', 't1');
    getApp.mockResolvedValue(appDef('shop'));
    const { seedMissingTenantAppDefs } = await import('../services/tenantAppDef');
    expect(await seedMissingTenantAppDefs()).toEqual({ seeded: 1, skipped: 0 });
    const written = JSON.parse(await fs.readFile(snapshot('shop', 't1'), 'utf-8'));
    expect(written.id).toBe('shop');
    expect(written).not.toHaveProperty('createdAt');
    expect(written).not.toHaveProperty('updatedAt');
  });

  it('skips an existing snapshot without touching it, and is idempotent', async () => {
    await mkTenant('shop', 't1');
    await fs.writeFile(snapshot('shop', 't1'), JSON.stringify({ frozen: true }));
    getApp.mockResolvedValue(appDef('shop'));
    const { seedMissingTenantAppDefs } = await import('../services/tenantAppDef');
    expect(await seedMissingTenantAppDefs()).toEqual({ seeded: 0, skipped: 1 });
    expect(JSON.parse(await fs.readFile(snapshot('shop', 't1'), 'utf-8'))).toEqual({ frozen: true });
    await mkTenant('shop', 't2');
    expect(await seedMissingTenantAppDefs()).toEqual({ seeded: 1, skipped: 1 });
    expect(await seedMissingTenantAppDefs()).toEqual({ seeded: 0, skipped: 2 });
  });

  it('leaves tenant dirs of an unregistered app alone', async () => {
    await mkTenant('ghost', 't1');
    getApp.mockResolvedValue(null);
    const { seedMissingTenantAppDefs } = await import('../services/tenantAppDef');
    expect(await seedMissingTenantAppDefs()).toEqual({ seeded: 0, skipped: 0 });
    await expect(fs.access(snapshot('ghost', 't1'))).rejects.toThrow();
  });

  it('treats any access() failure as "missing" (swallowed) and seeds', async () => {
    await mkTenant('shop', 't1');
    getApp.mockResolvedValue(appDef('shop'));
    const real = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    vi.doMock('fs/promises', () => {
      const access = (async (p: any, ...rest: any[]) => {
        if (String(p) === snapshot('shop', 't1')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        return (real.access as any)(p, ...rest);
      }) as typeof real.access;
      return { ...real, access, default: { ...real, access } };
    });
    const { seedMissingTenantAppDefs } = await import('../services/tenantAppDef');
    expect(await seedMissingTenantAppDefs()).toEqual({ seeded: 1, skipped: 0 });
  });

  it('does not swallow a failed write: the error propagates (the boot step logs it and continues)', async () => {
    await mkTenant('shop', 't1');
    getApp.mockResolvedValue({ ...appDef('shop'), services: [] }); // fails the static schema (min 1 service)
    const { seedMissingTenantAppDefs } = await import('../services/tenantAppDef');
    await expect(seedMissingTenantAppDefs()).rejects.toThrow(/Refusing to write invalid per-tenant definition/);
    await expect(fs.access(snapshot('shop', 't1'))).rejects.toThrow();
  });
});

describe('resolveTenantApp', () => {
  async function writeSnapshot(app: string, tenant: string, def: Record<string, unknown>) {
    await mkTenant(app, tenant);
    const { createdAt: _c, updatedAt: _u, ...staticDef } = def;
    void _c; void _u;
    await fs.writeFile(snapshot(app, tenant), JSON.stringify(staticDef));
  }

  it('keeps the snapshot shape and takes registry, default tag and identity from the global definition', async () => {
    await writeSnapshot('shop', 't1', appDef('old-shop', {
      services: [{ name: 'legacy', image_suffix: 'legacy' }], db_prefix: 'frozen', default_image_tag: 'old',
    }));
    getApp.mockResolvedValue(appDef('shop', {
      registry: { type: 'ghcr', url: 'ghcr.io', repository: 'o/new', auth: { type: 'token' } }, default_image_tag: 'new', db_prefix: 'global',
    }));
    const { resolveTenantApp } = await import('../services/tenantAppDef');
    const app = await resolveTenantApp('shop', 't1');
    expect(app).toMatchObject({
      id: 'shop', name: 'shop', domain_template: '*.shop.example', default_image_tag: 'new',
      registry: { repository: 'o/new' }, db_prefix: 'frozen', services: [{ name: 'legacy' }],
    });
  });

  it('returns the snapshot of a tenant whose app is in the trash', async () => {
    await writeSnapshot('shop', 't1', appDef('shop', { db_prefix: 'custom' }));
    getApp.mockResolvedValue(null);
    const { resolveTenantApp } = await import('../services/tenantAppDef');
    expect(await resolveTenantApp('shop', 't1')).toMatchObject({ id: 'shop', db_prefix: 'custom' });
  });

  it('falls back to the global definition without a snapshot, and is null without either', async () => {
    await mkTenant('shop', 't1');
    getApp.mockResolvedValue(appDef('shop'));
    const { resolveTenantApp } = await import('../services/tenantAppDef');
    expect(await resolveTenantApp('shop', 't1')).toMatchObject({ id: 'shop' });
    getApp.mockResolvedValue(null);
    expect(await resolveTenantApp('shop', 't1')).toBeNull();
  });
});
