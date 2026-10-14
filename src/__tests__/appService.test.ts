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
    const { dataDir } = await setupApp();
    const { deleteApp, purgeApp } = await import('../services/app');
    await deleteApp('acme', true, 'test@local');
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

