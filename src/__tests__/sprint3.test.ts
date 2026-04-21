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
    mw(mkReq({ appId: 'kwoutr' }), res, () => { throw new Error('should not call next'); });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/X-Confirm-Id/);
  });

  it('rejects with 400 when header does not match', () => {
    const mw = requireConfirmId('appId');
    const res = mkRes();
    mw(mkReq({ appId: 'kwoutr' }, { 'X-Confirm-Id': 'finalio' }), res, () => { throw new Error('should not call next'); });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/mismatch/);
  });

  it('passes when X-Confirm-Id header matches the param', () => {
    const mw = requireConfirmId('appId');
    const res = mkRes();
    let called = false;
    mw(mkReq({ appId: 'kwoutr' }, { 'X-Confirm-Id': 'kwoutr' }), res, () => { called = true; });
    expect(called).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it('accepts confirmId in body for POST-style handlers', () => {
    const mw = requireConfirmId('appId');
    const res = mkRes();
    let called = false;
    mw(mkReq({ appId: 'kwoutr' }, {}, { confirmId: 'kwoutr' }), res, () => { called = true; });
    expect(called).toBe(true);
  });
});

describe('R3 soft-delete — apps with tenants move to trash', () => {
  async function setupApp() {
    const dataDir = path.join(tmpRoot, 'data');
    const appsDir = path.join(tmpRoot, 'apps');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(path.join(appsDir, 'kwoutr', 'tenants', 't1'), { recursive: true });
    // Place a valid app in apps.json
    const app = {
      id: 'kwoutr',
      name: 'Kwoutr',
      domain_template: '*.kwoutr.com',
      registry: { type: 'ghcr', url: 'ghcr.io', repository: 'a/b', auth: { type: 'token' } },
      services: [{ name: 'web' }],
      default_image_tag: 'latest',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(dataDir, 'apps.json'), JSON.stringify([app]));
    vi.doMock('../config', () => ({ getDataDir: () => dataDir }));
    vi.doMock('../config/loader', () => ({ getAppsDir: () => appsDir }));
    vi.doMock('./fileLock', () => ({ withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn() }));
    return { dataDir, appsDir };
  }

  it('refuses delete without force when tenants exist', async () => {
    const { dataDir } = await setupApp();
    const { deleteApp } = await import('../services/app');
    await expect(deleteApp('kwoutr', false)).rejects.toThrow(/tenant/i);
    // apps.json untouched
    const after = JSON.parse(await fs.readFile(path.join(dataDir, 'apps.json'), 'utf-8'));
    expect(after).toHaveLength(1);
  });

  it('soft-deletes to apps.trashed.json when force=true with active tenants', async () => {
    const { dataDir } = await setupApp();
    const { deleteApp } = await import('../services/app');
    await deleteApp('kwoutr', true, 'test@local');

    const active = JSON.parse(await fs.readFile(path.join(dataDir, 'apps.json'), 'utf-8'));
    expect(active).toHaveLength(0);

    const trashed = JSON.parse(await fs.readFile(path.join(dataDir, 'apps.trashed.json'), 'utf-8'));
    expect(trashed).toHaveLength(1);
    expect(trashed[0].app.id).toBe('kwoutr');
    expect(trashed[0].deletedBy).toBe('test@local');
    expect(trashed[0].tenantCount).toBe(1);
  });

  it('restoreApp moves the entry back to apps.json', async () => {
    const { dataDir } = await setupApp();
    const { deleteApp, restoreApp } = await import('../services/app');
    await deleteApp('kwoutr', true, 'test@local');
    await restoreApp('kwoutr');

    const active = JSON.parse(await fs.readFile(path.join(dataDir, 'apps.json'), 'utf-8'));
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe('kwoutr');

    const trashed = JSON.parse(await fs.readFile(path.join(dataDir, 'apps.trashed.json'), 'utf-8'));
    expect(trashed).toHaveLength(0);
  });

  it('purgeApp permanently removes from trash', async () => {
    const { dataDir } = await setupApp();
    const { deleteApp, purgeApp } = await import('../services/app');
    await deleteApp('kwoutr', true, 'test@local');
    await purgeApp('kwoutr');

    const trashed = JSON.parse(await fs.readFile(path.join(dataDir, 'apps.trashed.json'), 'utf-8'));
    expect(trashed).toHaveLength(0);
  });
});
