import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let tmpRoot: string;
let dataDir: string;

function validStatic(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    domain_template: `*.${id}.example`,
    registry: { type: 'ghcr', url: 'ghcr.io', repository: `ns/${id}`, auth: { type: 'token' } },
    services: [{ name: 'web', image_suffix: 'web', ports: { internal: 80 } }],
    default_image_tag: 'latest',
    ...extra,
  };
}
const appFile = (id: string) => path.join(dataDir, 'apps.d', `${id}.json`);

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-apps-cache-'));
  dataDir = path.join(tmpRoot, 'data');
  await fs.mkdir(path.join(dataDir, 'apps.d'), { recursive: true });
  vi.doMock('../config', () => ({ getDataDir: () => dataDir }));
  vi.doMock('../config/loader', () => ({ getAppsDir: () => path.join(tmpRoot, 'apps'), loadConfig: () => ({}) }));
  vi.doMock('../services/fileLock', () => ({ withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn() }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock('fs/promises');
  vi.resetModules();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('readApps cache', () => {
  it('serves repeated reads without re-reading apps.d files', async () => {
    await fs.writeFile(appFile('acme'), JSON.stringify(validStatic('acme')));
    const readFile = vi.fn((...args: Parameters<typeof fs.readFile>) => fs.readFile(...args));
    vi.doMock('fs/promises', async (orig) => ({ ...(await orig<any>()), readFile }));
    const { listApps } = await import('../services/app');
    await listApps(); // first read also synthesises the runtime entry
    await listApps();
    readFile.mockClear();
    const apps = await listApps();
    expect(apps.map(a => a.id)).toEqual(['acme']);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('picks up an external edit to a file (CLI process) via size/mtime/ino', async () => {
    await fs.writeFile(appFile('acme'), JSON.stringify(validStatic('acme')));
    const { listApps } = await import('../services/app');
    expect((await listApps())[0].default_image_tag).toBe('latest');
    await listApps();
    await fs.writeFile(appFile('acme'), JSON.stringify(validStatic('acme', { default_image_tag: 'v2' })));
    expect((await listApps())[0].default_image_tag).toBe('v2');
  });

  it('picks up added and removed files', async () => {
    await fs.writeFile(appFile('acme'), JSON.stringify(validStatic('acme')));
    const { listApps } = await import('../services/app');
    await listApps();
    await listApps();
    await fs.writeFile(appFile('beta'), JSON.stringify(validStatic('beta')));
    expect((await listApps()).map(a => a.id)).toEqual(['acme', 'beta']);
    await fs.unlink(appFile('acme'));
    expect((await listApps()).map(a => a.id)).toEqual(['beta']);
  });

  it('never caches an error: a corrupt file throws every time, then recovers', async () => {
    await fs.writeFile(appFile('acme'), '{not json');
    const { listApps } = await import('../services/app');
    await expect(listApps()).rejects.toThrow(/not valid JSON/);
    await expect(listApps()).rejects.toThrow(/not valid JSON/);
    await fs.writeFile(appFile('acme'), JSON.stringify(validStatic('acme')));
    await expect(listApps()).resolves.toHaveLength(1);
  });

  it('returns defensive copies: mutating a result does not poison the cache', async () => {
    await fs.writeFile(appFile('acme'), JSON.stringify(validStatic('acme')));
    const { listApps } = await import('../services/app');
    const first = await listApps();
    await listApps();
    const second = await listApps();
    second[0].name = 'mutated';
    second[0].services.push({ name: 'x' } as any);
    second.length = 0;
    const third = await listApps();
    expect(third).toHaveLength(1);
    expect(third[0].name).toBe('acme');
    expect(third[0].services).toHaveLength(1);
    expect(first[0]).not.toBe(third[0]);
  });

  it('still synthesises and writes the runtime entry for a new file', async () => {
    await fs.writeFile(appFile('acme'), JSON.stringify(validStatic('acme')));
    const { listApps } = await import('../services/app');
    await listApps();
    const runtime = JSON.parse(await fs.readFile(path.join(dataDir, 'apps.runtime.json'), 'utf-8'));
    expect(runtime.acme.createdAt).toBeTruthy();
  });

  it('reflects in-process mutations immediately', async () => {
    await fs.writeFile(appFile('acme'), JSON.stringify(validStatic('acme')));
    const { listApps, deleteApp } = await import('../services/app');
    await listApps();
    await listApps();
    await deleteApp('acme');
    expect(await listApps()).toEqual([]);
  });

  it('invalidates in-process even when the file signature cannot change', async () => {
    await fs.writeFile(appFile('acme'), JSON.stringify(validStatic('acme', { default_image_tag: 'v1' })));
    // Constant stat results: the size/mtime/ino signature is blind to every write below,
    // so only the in-process invalidation can make a mutation visible.
    vi.doMock('fs/promises', async (orig) => {
      const actual = await orig<any>();
      const stat = async () => ({ mtimeMs: 1, size: 1, ino: 1, mtime: new Date(0) });
      return { ...actual, stat, default: { ...actual, stat } };
    });
    const { listApps, updateApp } = await import('../services/app');
    expect((await listApps())[0].default_image_tag).toBe('v1');
    await listApps();

    // External write (CLI): invisible through the blind signature, so the cache still serves v1.
    await fs.writeFile(appFile('acme'), JSON.stringify(validStatic('acme', { default_image_tag: 'v2' })));
    expect((await listApps())[0].default_image_tag).toBe('v1');

    // In-process mutation drops the cache.
    await updateApp({ id: 'acme', default_image_tag: 'v3' } as any);
    expect((await listApps())[0].default_image_tag).toBe('v3');
  });

  // Constant stat results make the cache signature blind, so these tests see only invalidation.
  function blindStat() {
    vi.doMock('fs/promises', async (orig) => {
      const actual = await orig<any>();
      const stat = async () => ({ mtimeMs: 1, size: 1, ino: 1, mtime: new Date(0) });
      return { ...actual, stat, default: { ...actual, stat } };
    });
  }

  it('invalidates after the write, so a read racing the runtime write cannot leave stale data cached', async () => {
    await fs.writeFile(appFile('acme'), JSON.stringify(validStatic('acme')));
    blindStat();
    let midWrite: (() => Promise<unknown>) | undefined;
    let hookRan = false;
    vi.doMock('../utils/atomicJson', async (orig) => {
      const actual = await orig<typeof import('../utils/atomicJson')>();
      return {
        ...actual,
        writeJsonAtomic: async (...args: Parameters<typeof actual.writeJsonAtomic>) => {
          if (String(args[0]).endsWith('apps.runtime.json') && midWrite) {
            const hook = midWrite;
            midWrite = undefined; // one race only
            hookRan = true;
            await hook();
          }
          return actual.writeJsonAtomic(...args);
        },
      };
    });
    const { listApps, updateApp } = await import('../services/app');
    const first = await listApps();
    await listApps();
    // updateApp rewrites the static file, then the runtime store (new updatedAt). A reader
    // that lands inside that last write caches the old runtime data.
    midWrite = () => listApps();
    await new Promise(resolve => setTimeout(resolve, 5)); // a distinct updatedAt millisecond
    const updated = await updateApp({ id: 'acme', name: 'Renamed' } as any);
    expect(updated.updatedAt).not.toBe(first[0].updatedAt);
    const after = (await listApps())[0];
    expect(hookRan).toBe(true);
    expect(after.updatedAt).toBe(updated.updatedAt);
    expect(after.name).toBe('Renamed');
    vi.doUnmock('../utils/atomicJson');
  });

  it('a throwing write still clears the cache', async () => {
    await fs.writeFile(appFile('acme'), JSON.stringify(validStatic('acme', { default_image_tag: 'v1' })));
    blindStat();
    let failNext = false;
    vi.doMock('../utils/atomicJson', async (orig) => {
      const actual = await orig<typeof import('../utils/atomicJson')>();
      return {
        ...actual,
        writeJsonAtomic: async (...args: Parameters<typeof actual.writeJsonAtomic>) => {
          if (failNext) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
          return actual.writeJsonAtomic(...args);
        },
      };
    });
    const { listApps, updateApp } = await import('../services/app');
    await listApps();
    await listApps();
    await fs.writeFile(appFile('acme'), JSON.stringify(validStatic('acme', { default_image_tag: 'v2' })));
    expect((await listApps())[0].default_image_tag).toBe('v1'); // blind signature: cached
    failNext = true;
    await expect(updateApp({ id: 'acme', name: 'x' } as any)).rejects.toThrow('ENOSPC');
    expect((await listApps())[0].default_image_tag).toBe('v2');
    vi.doUnmock('../utils/atomicJson');
  });

  it('picks up an mtime-only change (same size, same inode)', async () => {
    await fs.writeFile(appFile('acme'), JSON.stringify(validStatic('acme', { default_image_tag: 'v1' })));
    const { listApps } = await import('../services/app');
    await listApps();
    await listApps();
    const before = await fs.stat(appFile('acme'));
    await fs.writeFile(appFile('acme'), JSON.stringify(validStatic('acme', { default_image_tag: 'v2' })));
    await fs.utimes(appFile('acme'), before.atime, new Date(before.mtimeMs + 5000));
    expect((await fs.stat(appFile('acme'))).ino).toBe(before.ino);
    expect((await listApps())[0].default_image_tag).toBe('v2');
  });

  it('picks up an inode-only change (same size, same mtime, file replaced)', async () => {
    await fs.writeFile(appFile('acme'), JSON.stringify(validStatic('acme', { default_image_tag: 'v1' })));
    const { listApps } = await import('../services/app');
    await listApps();
    await listApps();
    const before = await fs.stat(appFile('acme'));
    const replacement = path.join(dataDir, 'replacement.json');
    await fs.writeFile(replacement, JSON.stringify(validStatic('acme', { default_image_tag: 'v2' })));
    await fs.utimes(replacement, before.atime, before.mtime);
    await fs.rename(replacement, appFile('acme'));
    const after = await fs.stat(appFile('acme'));
    expect(after.size).toBe(before.size);
    expect(after.ino).not.toBe(before.ino);
    expect((await listApps())[0].default_image_tag).toBe('v2');
  });
});
