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
