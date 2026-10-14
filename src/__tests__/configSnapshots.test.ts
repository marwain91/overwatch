import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-config-snapshots-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
});

describe('G2 configSnapshots', () => {
  it('create+list+restore round-trips apps.runtime.json and apps.d/', async () => {
    const dataDir = path.join(tmpRoot, 'data');
    await fs.mkdir(path.join(dataDir, 'apps.d'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'apps.runtime.json'), JSON.stringify({
      original: { createdAt: 'x', updatedAt: 'x' },
    }));
    await fs.writeFile(path.join(dataDir, 'apps.d', 'original.json'), JSON.stringify({ id: 'original' }));

    vi.doMock('../config', () => ({ getDataDir: () => dataDir }));
    const { createSnapshot, listSnapshots, restoreSnapshot } = await import('../services/configSnapshots');

    const snap = await createSnapshot('test');
    expect(snap.files).toContain('apps.runtime.json');
    expect(snap.files).toContain('apps.d/');

    // Overwrite to simulate loss.
    await fs.writeFile(path.join(dataDir, 'apps.runtime.json'), JSON.stringify({}));
    await fs.rm(path.join(dataDir, 'apps.d', 'original.json'));

    const all = await listSnapshots();
    expect(all.length).toBeGreaterThan(0);

    await restoreSnapshot(snap.name);
    const runtime = JSON.parse(await fs.readFile(path.join(dataDir, 'apps.runtime.json'), 'utf-8'));
    expect(runtime.original).toBeDefined();
    const appsD = await fs.readdir(path.join(dataDir, 'apps.d'));
    expect(appsD).toEqual(['original.json']);
  });

  it('preserves 0600 on secret files through snapshot/restore', async () => {
    const dataDir = path.join(tmpRoot, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'env-vars.json'), '{}', { mode: 0o600 });

    vi.doMock('../config', () => ({ getDataDir: () => dataDir }));
    const { createSnapshot, restoreSnapshot } = await import('../services/configSnapshots');

    const snap = await createSnapshot('secret-test');
    await fs.chmod(path.join(dataDir, 'env-vars.json'), 0o644);
    await restoreSnapshot(snap.name);
    const stat = await fs.stat(path.join(dataDir, 'env-vars.json'));
    expect(stat.mode & 0o777).toBe(0o600);
  });
});


