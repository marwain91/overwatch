import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-file-lock-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
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


