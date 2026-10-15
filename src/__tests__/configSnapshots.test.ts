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



describe('config snapshot safety', () => {
  let dataDir: string;

  async function load() {
    dataDir = path.join(tmpRoot, 'data');
    await fs.mkdir(path.join(dataDir, 'apps.d'), { recursive: true });
    vi.doMock('../config', () => ({ getDataDir: () => dataDir }));
    return import('../services/configSnapshots');
  }

  /** A finished snapshot directory as createSnapshot leaves it, with a chosen age. */
  async function fakeSnapshot(name: string, createdAt: Date, files: Record<string, string> = {}) {
    const dir = path.join(dataDir, '.snapshots', name);
    await fs.mkdir(dir, { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await fs.writeFile(path.join(dir, file), content);
    }
    await fs.writeFile(path.join(dir, 'snapshot.json'), JSON.stringify({
      name, createdAt: createdAt.toISOString(), files: Object.keys(files), totalBytes: 0,
    }));
  }

  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
  const names = async () => (await fs.readdir(path.join(dataDir, '.snapshots'))).sort();

  afterEach(() => {
    vi.doUnmock('fs/promises');
  });

  it('leaves audit.log and mcp-oauth.json out of snapshots', async () => {
    const { createSnapshot } = await load();
    await fs.writeFile(path.join(dataDir, 'audit.log'), '{"user":"a"}\n');
    await fs.writeFile(path.join(dataDir, 'mcp-oauth.json'), '{"clients":[]}', { mode: 0o600 });
    await fs.writeFile(path.join(dataDir, 'env-vars.json'), '{}', { mode: 0o600 });
    const snap = await createSnapshot('x');
    expect(snap.files).toContain('env-vars.json');
    expect(snap.files).not.toContain('audit.log');
    expect(snap.files).not.toContain('mcp-oauth.json');
    const stored = await fs.readdir(path.join(dataDir, '.snapshots', snap.name));
    expect(stored).not.toContain('audit.log');
    expect(stored).not.toContain('mcp-oauth.json');
  });

  it('restoring an older snapshot that still holds audit.log or mcp-oauth.json leaves the live ones alone', async () => {
    const { restoreSnapshot } = await load();
    await fs.writeFile(path.join(dataDir, 'audit.log'), 'live-audit\n');
    await fs.writeFile(path.join(dataDir, 'mcp-oauth.json'), '{"live":true}');
    await fakeSnapshot('old', minutesAgo(60), {
      'audit.log': 'old-audit\n', 'mcp-oauth.json': '{"old":true}', 'env-vars.json': '{"shop":[]}',
    });
    await restoreSnapshot('old');
    expect(await fs.readFile(path.join(dataDir, 'audit.log'), 'utf-8')).toBe('live-audit\n');
    expect(await fs.readFile(path.join(dataDir, 'mcp-oauth.json'), 'utf-8')).toBe('{"live":true}');
    expect(await fs.readFile(path.join(dataDir, 'env-vars.json'), 'utf-8')).toBe('{"shop":[]}');
  });

  it.each(['../outside', '..', '.', '', 'a/b', '/etc'])('refuses snapshot name %j that is not a direct child of the snapshots root', async (name) => {
    const { restoreSnapshot } = await load();
    await fs.writeFile(path.join(dataDir, 'env-vars.json'), '{"live":[]}');
    // A snapshot-shaped directory outside .snapshots that a traversal would reach.
    const outside = path.join(dataDir, '.snapshots', '..', 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'snapshot.json'), '{}');
    await fs.writeFile(path.join(outside, 'env-vars.json'), '{"evil":[]}');
    await fs.mkdir(path.join(dataDir, '.snapshots'), { recursive: true });
    await expect(restoreSnapshot(name)).rejects.toThrow(/snapshot/i);
    expect(await fs.readFile(path.join(dataDir, 'env-vars.json'), 'utf-8')).toBe('{"live":[]}');
  });

  it('refuses an incomplete snapshot (no snapshot.json)', async () => {
    const { restoreSnapshot } = await load();
    await fs.writeFile(path.join(dataDir, 'apps.d', 'live.json'), '{"id":"live"}');
    await fs.mkdir(path.join(dataDir, '.snapshots', 'half', 'apps.d'), { recursive: true });
    await expect(restoreSnapshot('half')).rejects.toThrow(/not found|incomplete/i);
    expect(await fs.readdir(path.join(dataDir, 'apps.d'))).toEqual(['live.json']);
  });

  it('a restore that fails part-way leaves the live state untouched', async () => {
    const snapDir = () => path.join(dataDir, '.snapshots', 'good');
    vi.doMock('fs/promises', async () => {
      const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
      return {
        ...actual,
        copyFile: async (src: any, dest: any, mode?: number) => {
          if (String(src) === path.join(snapDir(), 'apps.d', 'b.json')) {
            throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
          }
          return actual.copyFile(src, dest, mode);
        },
      };
    });
    const { restoreSnapshot } = await load();
    await fs.writeFile(path.join(dataDir, 'apps.d', 'live.json'), '{"id":"live"}');
    await fs.writeFile(path.join(dataDir, 'env-vars.json'), '{"live":[]}');
    await fakeSnapshot('good', minutesAgo(5), {
      'apps.d/a.json': '{"id":"a"}', 'apps.d/b.json': '{"id":"b"}', 'env-vars.json': '{"old":[]}',
    });
    await expect(restoreSnapshot('good')).rejects.toThrow(/EIO/);
    expect(await fs.readdir(path.join(dataDir, 'apps.d'))).toEqual(['live.json']);
    expect(await fs.readFile(path.join(dataDir, 'env-vars.json'), 'utf-8')).toBe('{"live":[]}');
  });

  it('refuses to restore a snapshot holding a corrupt JSON file, before touching anything', async () => {
    const { restoreSnapshot } = await load();
    await fs.writeFile(path.join(dataDir, 'apps.d', 'live.json'), '{"id":"live"}');
    await fakeSnapshot('bad', minutesAgo(5), { 'apps.d/a.json': '{"id":', 'env-vars.json': '{}' });
    await expect(restoreSnapshot('bad')).rejects.toThrow(/a\.json/);
    expect(await fs.readdir(path.join(dataDir, 'apps.d'))).toEqual(['live.json']);
  });

  it('waits for the writers\' locks before replacing their files', async () => {
    const { restoreSnapshot } = await load();
    const { withFileLock } = await import('../services/fileLock');
    await fs.writeFile(path.join(dataDir, 'apps.d', 'live.json'), '{"id":"live"}');
    await fakeSnapshot('s', minutesAgo(5), { 'apps.d/old.json': '{"id":"old"}' });
    let release!: () => void;
    const held = withFileLock('apps', () => new Promise<void>(r => { release = r; }));
    await new Promise(r => setTimeout(r, 20));
    const restoring = restoreSnapshot('s');
    await new Promise(r => setTimeout(r, 200));
    expect(await fs.readdir(path.join(dataDir, 'apps.d'))).toEqual(['live.json']);
    release();
    await held;
    await restoring;
    expect(await fs.readdir(path.join(dataDir, 'apps.d'))).toEqual(['old.json']);
  });

  // The CLI usually runs as root on the host while the server runs as the data
  // dir's owner: restored files must stay readable by the server.
  it.skipIf(process.getuid?.() !== 0)('restored files keep the owner of the files they replace', async () => {
    const { restoreSnapshot } = await load();
    await fs.writeFile(path.join(dataDir, 'env-vars.json'), '{"live":[]}', { mode: 0o600 });
    await fs.writeFile(path.join(dataDir, 'apps.d', 'a.json'), '{"id":"a"}');
    await fs.chown(path.join(dataDir, 'env-vars.json'), 1234, 1234);
    await fs.chown(path.join(dataDir, 'apps.d'), 1234, 1234);
    await fs.chown(path.join(dataDir, 'apps.d', 'a.json'), 1234, 1234);
    await fakeSnapshot('s', minutesAgo(5), { 'env-vars.json': '{"old":[]}', 'apps.d/a.json': '{"id":"a","v":2}', 'apps.d/b.json': '{"id":"b"}' });
    await restoreSnapshot('s');
    for (const f of ['env-vars.json', 'apps.d/a.json', 'apps.d/b.json']) {
      const st = await fs.stat(path.join(dataDir, f));
      expect([f, st.uid, st.gid]).toEqual([f, 1234, 1234]);
    }
  });

  it('pruneOldSnapshots refuses to keep fewer than one snapshot', async () => {
    const { pruneOldSnapshots } = await load();
    await fakeSnapshot('a_daily', minutesAgo(10));
    await expect(pruneOldSnapshots(0)).rejects.toThrow(/at least 1/);
    await expect(pruneOldSnapshots(-1)).rejects.toThrow(/at least 1/);
    await expect(pruneOldSnapshots(Number.NaN)).rejects.toThrow(/at least 1/);
    expect(await names()).toEqual(['a_daily']);
  });

  it('boot snapshots are capped on their own and never evict daily snapshots', async () => {
    const { pruneOldSnapshots } = await load();
    for (let i = 0; i < 5; i++) await fakeSnapshot(`d${i}_daily`, minutesAgo(10_000 + i));
    for (let i = 0; i < 40; i++) await fakeSnapshot(`b${String(i).padStart(2, '0')}_boot`, minutesAgo(40 - i));
    await pruneOldSnapshots(30);
    const left = await names();
    expect(left.filter(n => n.endsWith('_daily'))).toHaveLength(5);
    const boots = left.filter(n => n.endsWith('_boot'));
    expect(boots.length).toBeLessThanOrEqual(10);
    expect(boots).toContain('b39_boot'); // the newest boot snapshots are the ones kept
  });

  it('createBootSnapshot skips when a snapshot is less than ten minutes old', async () => {
    const { createBootSnapshot } = await load();
    await fakeSnapshot('recent_daily', minutesAgo(3));
    expect(await createBootSnapshot()).toBeNull();
    expect(await names()).toEqual(['recent_daily']);
  });

  it('createBootSnapshot takes one when the newest is older, then prunes boot snapshots right away', async () => {
    const { createBootSnapshot } = await load();
    for (let i = 0; i < 15; i++) await fakeSnapshot(`b${String(i).padStart(2, '0')}_boot`, minutesAgo(100 - i));
    for (let i = 0; i < 3; i++) await fakeSnapshot(`d${i}_daily`, minutesAgo(5_000 + i));
    const info = await createBootSnapshot();
    expect(info?.name).toMatch(/_boot$/);
    const left = await names();
    expect(left.filter(n => n.endsWith('_daily'))).toHaveLength(3);
    expect(left.filter(n => n.endsWith('_boot')).length).toBeLessThanOrEqual(10);
    expect(left).toContain(info!.name);
  });
});

describe('overwatch snapshot prune --keep', () => {
  class ExitError extends Error {
    constructor(public code: number) { super(`exit ${code}`); }
  }

  it.each(['0', '-1', 'abc', '2.5'])('rejects --keep %s without pruning anything', async (keep) => {
    const pruneOldSnapshots = vi.fn(async () => 0);
    vi.doMock('../services/configSnapshots', () => ({
      createSnapshot: vi.fn(), listSnapshots: vi.fn(), restoreSnapshot: vi.fn(), pruneOldSnapshots,
    }));
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.join(' ')); });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new ExitError(code ?? 0); }) as never);
    try {
      const { runSnapshot } = await import('../cli/snapshot');
      await expect(runSnapshot(['prune', '--keep', keep])).rejects.toMatchObject({ code: 1 });
      expect(pruneOldSnapshots).not.toHaveBeenCalled();
      expect(errors.join('\n')).toMatch(/--keep/);
    } finally {
      vi.restoreAllMocks();
      vi.doUnmock('../services/configSnapshots');
    }
  });
});
