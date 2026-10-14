import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-hook-'));
  await fs.mkdir(path.join(dir, 'apps.d'));
});
afterEach(async () => {
  vi.resetModules();
  vi.doUnmock('../config');
  await fs.rm(dir, { recursive: true, force: true });
});

const input = (id: string) => ({
  id, name: id, domain_template: `*.${id}.example`,
  services: [{ name: 'web', image_suffix: 'web', ports: { internal: 80 } }],
  registry: { type: 'ghcr', url: 'ghcr.io', repository: 'o/r', auth: { type: 'token', token_env: 'X' } },
}) as any;

describe('apps changed hook', () => {
  it('fires after create, update and delete, but not after a failed mutation', async () => {
    vi.doMock('../config', async (orig) => ({ ...(await orig<any>()), getDataDir: () => dir }));
    const svc = await import('../services/app');
    const hook = vi.fn();
    svc.setAppsChangedHook(hook);

    await svc.createApp(input('a'));
    expect(hook).toHaveBeenCalledTimes(1);
    await expect(svc.createApp(input('a'))).rejects.toThrow();
    expect(hook).toHaveBeenCalledTimes(1);
    await svc.updateApp({ id: 'a', name: 'A2' } as any);
    expect(hook).toHaveBeenCalledTimes(2);
    await svc.deleteApp('a');
    expect(hook).toHaveBeenCalledTimes(3);
  });

  it('a throwing hook does not fail the mutation', async () => {
    vi.doMock('../config', async (orig) => ({ ...(await orig<any>()), getDataDir: () => dir }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const svc = await import('../services/app');
    svc.setAppsChangedHook(() => { throw new Error('boom'); });
    await expect(svc.createApp(input('b'))).resolves.toBeTruthy();
  });
});

describe('apps changed hook on apply / restore / purge', () => {
  async function setup() {
    const appsRoot = path.join(dir, 'appsroot');
    await fs.mkdir(path.join(appsRoot, 'gone', 'tenants', 't1'), { recursive: true });
    vi.doMock('../config', async (orig) => ({ ...(await orig<any>()), getDataDir: () => dir }));
    vi.doMock('../config/loader', async (orig) => ({ ...(await orig<any>()), getAppsDir: () => appsRoot }));
    const svc = await import('../services/app');
    const hook = vi.fn();
    svc.setAppsChangedHook(hook);
    return { svc, hook };
  }
  const staticDef = (id: string) => {
    const { createdAt, updatedAt, ...rest } = { ...input(id), createdAt: '', updatedAt: '' };
    return rest;
  };

  afterEach(() => { vi.doUnmock('../config/loader'); });

  it('fires after applyApp creates or updates, but not for a no-op apply', async () => {
    const { svc, hook } = await setup();
    await svc.applyApp(staticDef('a'), 'test');
    expect(hook).toHaveBeenCalledTimes(1);
    await svc.applyApp({ ...staticDef('a'), name: 'Renamed' }, 'test');
    expect(hook).toHaveBeenCalledTimes(2);
    await svc.applyApp({ ...staticDef('a'), name: 'Renamed' }, 'test');
    expect(hook).toHaveBeenCalledTimes(2);
  });

  it('fires after restoreApp and purgeApp, but not when they fail', async () => {
    const { svc, hook } = await setup();
    await svc.createApp(input('gone'));
    await svc.deleteApp('gone', true, 'tester'); // has a tenant -> soft-deleted into the trash
    hook.mockClear();

    await expect(svc.restoreApp('missing')).rejects.toThrow();
    await expect(svc.purgeApp('missing')).rejects.toThrow();
    expect(hook).not.toHaveBeenCalled();

    await svc.restoreApp('gone');
    expect(hook).toHaveBeenCalledTimes(1);
    await svc.deleteApp('gone', true, 'tester');
    hook.mockClear();
    await svc.purgeApp('gone');
    expect(hook).toHaveBeenCalledTimes(1);
  });
});
