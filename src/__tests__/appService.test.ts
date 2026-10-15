import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-app-service-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.doUnmock('../adapters/registry');
  vi.resetModules();
});

describe('G1 readApps — refuses to silently accept corrupt JSON', () => {
  it('throws a clear error when an apps.d/ file is malformed', async () => {
    const dataDir = path.join(tmpRoot, 'data');
    await fs.mkdir(path.join(dataDir, 'apps.d'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'apps.d', 'broken.json'), '{not valid json');

    vi.doMock('../config', () => ({ getDataDir: () => dataDir, getAppsDir: () => path.join(tmpRoot, 'apps') }));

    const { listApps } = await import('../services/app');
    await expect(listApps()).rejects.toThrow(/broken\.json is not valid JSON/);
  });

  it('throws when an apps.d/ file has an invalid app entry (schema drift)', async () => {
    const dataDir = path.join(tmpRoot, 'data');
    await fs.mkdir(path.join(dataDir, 'apps.d'), { recursive: true });
    // Missing required `name`, `domain_template`, `registry`, `services`…
    await fs.writeFile(path.join(dataDir, 'apps.d', 'incomplete.json'), JSON.stringify({ id: 'incomplete' }));

    vi.doMock('../config', () => ({ getDataDir: () => dataDir, getAppsDir: () => path.join(tmpRoot, 'apps') }));

    const { listApps } = await import('../services/app');
    await expect(listApps()).rejects.toThrow(/incomplete\.json failed validation/);
  });
});


describe('R3 soft-delete — apps with tenants move to trash', () => {
  async function setupApp() {
    const dataDir = path.join(tmpRoot, 'data');
    const appsDir = path.join(tmpRoot, 'apps');
    await fs.mkdir(path.join(dataDir, 'apps.d'), { recursive: true });
    await fs.mkdir(path.join(appsDir, 'acme', 'tenants', 't1'), { recursive: true });
    const staticDef = {
      id: 'acme',
      name: 'Acme',
      domain_template: '*.acme.com',
      registry: { type: 'ghcr', url: 'ghcr.io', repository: 'a/b', auth: { type: 'token' } },
      services: [{ name: 'web' }],
      default_image_tag: 'latest',
    };
    await fs.writeFile(path.join(dataDir, 'apps.d', 'acme.json'), JSON.stringify(staticDef));
    await fs.writeFile(path.join(dataDir, 'apps.runtime.json'), JSON.stringify({
      acme: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    }));
    vi.doMock('../config', () => ({ getDataDir: () => dataDir }));
    vi.doMock('../config/loader', () => ({ getAppsDir: () => appsDir }));
    return { dataDir, appsDir };
  }

  it('refuses delete without force when tenants exist', async () => {
    const { dataDir } = await setupApp();
    const { deleteApp } = await import('../services/app');
    await expect(deleteApp('acme', false)).rejects.toThrow(/tenant/i);
    // apps.d untouched
    const after = await fs.readdir(path.join(dataDir, 'apps.d'));
    expect(after).toEqual(['acme.json']);
  });

  it('soft-deletes to apps.trashed.json when force=true with active tenants', async () => {
    const { dataDir } = await setupApp();
    const { deleteApp } = await import('../services/app');
    await deleteApp('acme', true, 'test@local');

    const active = await fs.readdir(path.join(dataDir, 'apps.d'));
    expect(active).toEqual([]);

    const trashed = JSON.parse(await fs.readFile(path.join(dataDir, 'apps.trashed.json'), 'utf-8'));
    expect(trashed).toHaveLength(1);
    expect(trashed[0].app.id).toBe('acme');
    expect(trashed[0].deletedBy).toBe('test@local');
    expect(trashed[0].tenantCount).toBe(1);
  });

  it('restoreApp moves the entry back to apps.d/', async () => {
    const { dataDir } = await setupApp();
    const { deleteApp, restoreApp } = await import('../services/app');
    await deleteApp('acme', true, 'test@local');
    await restoreApp('acme');

    const active = await fs.readdir(path.join(dataDir, 'apps.d'));
    expect(active).toEqual(['acme.json']);

    const trashed = JSON.parse(await fs.readFile(path.join(dataDir, 'apps.trashed.json'), 'utf-8'));
    expect(trashed).toHaveLength(0);
  });

  it('purgeApp permanently removes from trash', async () => {
    const { dataDir, appsDir } = await setupApp();
    const { deleteApp, purgeApp } = await import('../services/app');
    await deleteApp('acme', true, 'test@local');
    // Its tenants are gone (deleted through the tenant lifecycle).
    await fs.rm(path.join(appsDir, 'acme', 'tenants', 't1'), { recursive: true });
    await purgeApp('acme');

    const trashed = JSON.parse(await fs.readFile(path.join(dataDir, 'apps.trashed.json'), 'utf-8'));
    expect(trashed).toHaveLength(0);
  });
});

describe('updateApp registry cache invalidation', () => {
  it('clears the per-app registry adapter after API-style app updates', async () => {
    const dataDir = path.join(tmpRoot, 'data');
    await fs.mkdir(path.join(dataDir, 'apps.d'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'apps.d', 'acme.json'), JSON.stringify({
      id: 'acme',
      name: 'Acme',
      domain_template: '*.acme.test',
      registry: { type: 'ghcr', url: 'ghcr.io', repository: 'org/acme', auth: { type: 'token' } },
      services: [{ name: 'web' }],
      default_image_tag: 'latest',
    }));
    await fs.writeFile(path.join(dataDir, 'apps.runtime.json'), JSON.stringify({
      acme: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    }));

    const clearAdapterCache = vi.fn();
    vi.doMock('../config', () => ({ getDataDir: () => dataDir }));
    vi.doMock('../adapters/registry', () => ({ clearAdapterCache }));

    const { updateApp } = await import('../services/app');
    await updateApp({ id: 'acme', default_image_tag: 'stable' });

    expect(clearAdapterCache).toHaveBeenCalledWith('acme');
  });
});


describe('app write invariants live in the service', () => {
  let dataDir: string;
  let appsDir: string;

  function def(id: string, extra: Record<string, unknown> = {}) {
    return {
      id,
      name: id.toUpperCase(),
      domain_template: `*.${id}.test`,
      registry: { type: 'ghcr' as const, url: 'ghcr.io', repository: `org/${id}`, auth: { type: 'token' as const } },
      services: [{ name: 'web', ports: { internal: 80 } }],
      default_image_tag: 'latest',
      ...extra,
    } as any;
  }

  async function load() {
    dataDir = path.join(tmpRoot, 'data');
    appsDir = path.join(tmpRoot, 'apps');
    await fs.mkdir(path.join(dataDir, 'apps.d'), { recursive: true });
    vi.doMock('../config', () => ({ getDataDir: () => dataDir, getAppsDir: () => appsDir }));
    vi.doMock('../config/loader', () => ({ getAppsDir: () => appsDir }));
    vi.doMock('../adapters/registry', () => ({ clearAdapterCache: () => {} }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    return import('../services/app');
  }

  afterEach(() => {
    vi.doUnmock('../config');
    vi.doUnmock('../config/loader');
    vi.restoreAllMocks();
  });

  const appsD = () => fs.readdir(path.join(dataDir, 'apps.d'));

  it.each([
    ['a service name that is not a slug', { services: [{ name: 'Web_1' }] }, /service name/i],
    ['a bad health-check duration', { services: [{ name: 'web', health_check: { path: '/h', interval: '30' } }] }, /health_check\.interval/],
    ['raw labels for a router the app does not own', {
      services: [{ name: 'web', ports: { internal: 80 }, routing: { raw_labels: { 'traefik.http.routers.admin.priority': '100000' } } }],
    }, /not one of this tenant's own routers/],
    ['a masked credential copied from a non-admin read', {
      traefik: { middlewares: { auth: { type: 'basicAuth', users: ['ops:••••••••'] } } },
    }, /mask|placeholder|credential/i],
  ])('createApp refuses %s', async (_what, extra, message) => {
    const { createApp } = await load();
    await expect(createApp(def('shop', extra))).rejects.toThrow(message);
    expect(await appsD()).toEqual([]);
  });

  it('applyApp refuses a bad health-check duration (the CLI no longer checks it by hand)', async () => {
    const { applyApp } = await load();
    await expect(applyApp(def('shop', { services: [{ name: 'web', health_check: { path: '/h', start_period: 'soon' } }] }), 'cli:test'))
      .rejects.toThrow(/health_check\.start_period/);
    expect(await appsD()).toEqual([]);
  });

  it('updateApp checks changed values but lets a stored legacy value be saved again', async () => {
    const { updateApp } = await load();
    const { createdAt: _c, updatedAt: _u, ...legacy } = def('shop', { services: [{ name: 'legacy_worker' }] });
    await fs.writeFile(path.join(dataDir, 'apps.d', 'shop.json'), JSON.stringify(legacy));
    await expect(updateApp({ id: 'shop', default_image_tag: 'stable' })).resolves.toMatchObject({ default_image_tag: 'stable' });
    await expect(updateApp({ id: 'shop', services: [{ name: 'legacy_worker' }, { name: 'New Svc' }] } as any)).rejects.toThrow(/service name/i);
  });

  it('createApp refuses an id that is in the trash instead of re-adopting its tenants', async () => {
    const { createApp, deleteApp } = await load();
    await createApp(def('shop'));
    await fs.mkdir(path.join(appsDir, 'shop', 'tenants', 't1'), { recursive: true });
    await deleteApp('shop', true, 'ops@test');
    const { ConflictError } = await import('../utils/httpErrors');
    const err = await createApp(def('shop', { name: 'Impostor' })).catch(e => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toMatch(/trash/);
    expect(await appsD()).toEqual([]);
  });

  it('createApp and updateApp pre-populate declared env vars like applyApp does', async () => {
    const { createApp, updateApp } = await load();
    await createApp(def('shop', { env_vars: [{ key: 'API_URL', description: 'Upstream API' }] }));
    await updateApp({ id: 'shop', env_vars: [{ key: 'API_URL' }, { key: 'SMTP_HOST', sensitive: false }] } as any);
    const store = JSON.parse(await fs.readFile(path.join(dataDir, 'env-vars.json'), 'utf-8'));
    expect(store.shop.map((v: any) => v.key).sort()).toEqual(['API_URL', 'SMTP_HOST']);
  });

  it('purgeApp refuses while tenant directories exist, so live tenants never become invisible', async () => {
    const { createApp, deleteApp, purgeApp, listTrashedApps } = await load();
    await createApp(def('shop'));
    await fs.mkdir(path.join(appsDir, 'shop', 'tenants', 't1'), { recursive: true });
    await deleteApp('shop', true, 'ops@test');
    await expect(purgeApp('shop')).rejects.toThrow(/tenant/i);
    expect((await listTrashedApps()).map(t => t.app.id)).toEqual(['shop']);
  });

  it('purgeApp drops a trash entry whose tenants belong to a live app of the same id', async () => {
    const { createApp, deleteApp, purgeApp, listTrashedApps } = await load();
    await createApp(def('shop'));
    await fs.mkdir(path.join(appsDir, 'shop', 'tenants', 't1'), { recursive: true });
    await deleteApp('shop', true, 'ops@test');
    // A live app with the same id (created before create refused trashed ids).
    const { createdAt: _c, updatedAt: _u, ...live } = def('shop');
    await fs.writeFile(path.join(dataDir, 'apps.d', 'shop.json'), JSON.stringify(live));
    await purgeApp('shop');
    expect(await listTrashedApps()).toEqual([]);
  });
});
