import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { writeJsonAtomic, readJsonStrict } from '../utils/atomicJson';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-sprint2-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
});

describe('R1 writeJsonAtomic — atomic rename', () => {
  it('writes the final file at the requested mode', async () => {
    const target = path.join(tmpRoot, 'apps.json');
    await writeJsonAtomic(target, [{ id: 'a' }, { id: 'b' }], { mode: 0o600 });
    const stat = await fs.stat(target);
    expect(stat.mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(await fs.readFile(target, 'utf-8'));
    expect(parsed).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('does not leave behind tmp files after a successful write', async () => {
    const target = path.join(tmpRoot, 'apps.json');
    await writeJsonAtomic(target, { ok: 1 });
    const siblings = await fs.readdir(tmpRoot);
    expect(siblings).toEqual(['apps.json']);
  });

  it('readJsonStrict throws a useful error on malformed JSON', async () => {
    const target = path.join(tmpRoot, 'corrupt.json');
    await fs.writeFile(target, '{not valid');
    await expect(readJsonStrict(target)).rejects.toThrow(/not valid JSON/);
  });
});

describe('R1 withFileLock — cross-process-safe lockfile + in-process serialisation', () => {
  it('serialises concurrent callers in the same process', async () => {
    const dataDir = path.join(tmpRoot, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    vi.doMock('../config', () => ({ getDataDir: () => dataDir }));
    const { withFileLock } = await import('../services/fileLock');

    const seq: number[] = [];
    const work = (id: number, ms: number) => withFileLock('test', async () => {
      seq.push(id);
      await new Promise(r => setTimeout(r, ms));
      seq.push(id);
    });
    await Promise.all([work(1, 30), work(2, 10), work(3, 5)]);
    // Each id should appear as a non-interleaved pair.
    expect(seq).toEqual([1, 1, 2, 2, 3, 3]);
  });

  it('reclaims a stale lockfile whose PID is dead', async () => {
    const dataDir = path.join(tmpRoot, 'data');
    await fs.mkdir(path.join(dataDir, '.locks'), { recursive: true });
    // Write a lockfile with an impossibly-old timestamp and a fake dead PID.
    await fs.writeFile(path.join(dataDir, '.locks', 'test.lock'), '4194304\n0\n', { mode: 0o600 });
    vi.doMock('../config', () => ({ getDataDir: () => dataDir }));
    const { withFileLock } = await import('../services/fileLock');

    const result = await withFileLock('test', async () => 'ok');
    expect(result).toBe('ok');
  });
});

describe('R2 schemaVersions — refuses data newer than code', () => {
  it('findPendingMigrations throws on newer-than-code version', async () => {
    const { findPendingMigrations, CURRENT_SCHEMA_VERSIONS } = await import('../services/schemaVersions');
    expect(() => findPendingMigrations({ apps: CURRENT_SCHEMA_VERSIONS.apps + 1 }))
      .toThrow(/newer than code/);
  });

  it('returns empty when stored versions match current', async () => {
    const { findPendingMigrations, CURRENT_SCHEMA_VERSIONS } = await import('../services/schemaVersions');
    expect(findPendingMigrations(CURRENT_SCHEMA_VERSIONS)).toEqual([]);
  });

  it('returns pending list when stored version is older', async () => {
    const { findPendingMigrations, CURRENT_SCHEMA_VERSIONS } = await import('../services/schemaVersions');
    const pending = findPendingMigrations({ apps: 1, envVars: CURRENT_SCHEMA_VERSIONS.envVars });
    expect(pending).toEqual([{ store: 'apps', from: 1, to: CURRENT_SCHEMA_VERSIONS.apps }]);
  });
});

describe('G2 configSnapshots', () => {
  it('create+list+restore round-trips apps.json', async () => {
    const dataDir = path.join(tmpRoot, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'apps.json'), JSON.stringify([{ id: 'original' }]));

    vi.doMock('../config', () => ({ getDataDir: () => dataDir }));
    const { createSnapshot, listSnapshots, restoreSnapshot } = await import('../services/configSnapshots');

    const snap = await createSnapshot('test');
    expect(snap.files).toContain('apps.json');

    // Overwrite current state to simulate loss
    await fs.writeFile(path.join(dataDir, 'apps.json'), JSON.stringify([{ id: 'overwritten' }]));

    const all = await listSnapshots();
    expect(all.length).toBeGreaterThan(0);

    await restoreSnapshot(snap.name);
    const restored = JSON.parse(await fs.readFile(path.join(dataDir, 'apps.json'), 'utf-8'));
    expect(restored).toEqual([{ id: 'original' }]);
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

describe('G8 audit queue — persists entries even with concurrent writes', () => {
  it('flushes enqueued entries in order', async () => {
    const dataDir = path.join(tmpRoot, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    vi.doMock('../config', () => ({ getDataDir: () => dataDir }));
    vi.doMock('../utils/jwt', () => ({ getCurrentUserEmail: () => 'a@b.c' }));

    const { auditLog, flushAuditLog } = await import('../middleware/audit');
    const mkReq = (p: string) => ({
      method: 'DELETE', baseUrl: '/api/apps', path: `/${p}`,
      query: {}, body: {}, ip: '1.2.3.4', socket: { remoteAddress: '1.2.3.4' },
    });
    const mkRes = () => ({ statusCode: 200, json: (b: any) => b });

    for (const p of ['one', 'two', 'three']) {
      const res: any = mkRes();
      auditLog(mkReq(p) as any, res, () => {});
      res.json({ ok: true });
    }
    await flushAuditLog();
    const log = await fs.readFile(path.join(dataDir, 'audit.log'), 'utf-8');
    const lines = log.trim().split('\n').map(l => JSON.parse(l));
    expect(lines.map(l => l.action)).toEqual(['delete app one', 'delete app two', 'delete app three']);
  });
});
