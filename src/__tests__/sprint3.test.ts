import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { requireConfirmId } from '../middleware/confirmDestructive';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-sprint3-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
});

describe('R3 requireConfirmId middleware', () => {
  const mkReq = (params: any, headers: Record<string, string> = {}, body: any = {}) => ({
    params,
    body,
    header: (name: string) => headers[name],
  }) as any;

  const mkRes = () => {
    const res: any = { statusCode: 200, body: undefined };
    res.status = (s: number) => { res.statusCode = s; return res; };
    res.json = (b: any) => { res.body = b; return res; };
    return res;
  };

  it('rejects with 400 when header is missing', () => {
    const mw = requireConfirmId('appId');
    const res = mkRes();
    mw(mkReq({ appId: 'acme' }), res, () => { throw new Error('should not call next'); });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/X-Confirm-Id/);
  });

  it('rejects with 400 when header does not match', () => {
    const mw = requireConfirmId('appId');
    const res = mkRes();
    mw(mkReq({ appId: 'acme' }, { 'X-Confirm-Id': 'gadgets' }), res, () => { throw new Error('should not call next'); });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/mismatch/);
  });

  it('passes when X-Confirm-Id header matches the param', () => {
    const mw = requireConfirmId('appId');
    const res = mkRes();
    let called = false;
    mw(mkReq({ appId: 'acme' }, { 'X-Confirm-Id': 'acme' }), res, () => { called = true; });
    expect(called).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it('accepts confirmId in body for POST-style handlers', () => {
    const mw = requireConfirmId('appId');
    const res = mkRes();
    let called = false;
    mw(mkReq({ appId: 'acme' }, {}, { confirmId: 'acme' }), res, () => { called = true; });
    expect(called).toBe(true);
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
    vi.doMock('./fileLock', () => ({ withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn() }));
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
