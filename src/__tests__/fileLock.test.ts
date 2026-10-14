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



describe('stale lockfile reclamation', () => {
  async function setup(content: string) {
    const dataDir = path.join(tmpRoot, 'data');
    await fs.mkdir(path.join(dataDir, '.locks'), { recursive: true });
    await fs.writeFile(path.join(dataDir, '.locks', 'test.lock'), content, { mode: 0o600 });
    vi.doMock('../config', () => ({ getDataDir: () => dataDir }));
    return (await import('../services/fileLock')).withFileLock;
  }

  // Overwatch is PID 1 on every container start, so a lock left by a killed
  // previous run carries our own PID and must not look like a live holder.
  const beforeProcessStart = () => Date.now() - process.uptime() * 1000 - 10_000;
  const lockFile = () => path.join(tmpRoot, 'data', '.locks', 'test.lock');

  it('reclaims immediately a lockfile that carries our own PID and predates this process', async () => {
    const withFileLock = await setup(`${process.pid}\n${beforeProcessStart()}\n`);
    const started = Date.now();
    expect(await withFileLock('test', async () => 'ok')).toBe('ok');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('reclaims a same-PID lockfile with a foreign instance id when it predates this process', async () => {
    const withFileLock = await setup(`${process.pid}\n${beforeProcessStart()}\nsome-dead-instance\n`);
    expect(await withFileLock('test', async () => 'ok')).toBe('ok');
  });

  it('does not steal a same-PID lock written after this process started by another instance (two PID-1 containers)', async () => {
    const withFileLock = await setup(`${process.pid}\n${Date.now()}\nother-container-instance\n`);
    let acquired = false;
    const p = withFileLock('test', async () => { acquired = true; });
    await new Promise(r => setTimeout(r, 400));
    expect(acquired).toBe(false);
    expect(await fs.readFile(lockFile(), 'utf-8')).toContain('other-container-instance');
    await fs.unlink(lockFile()); // the other container releases
    await p;
    expect(acquired).toBe(true);
  });

  it('also keeps a same-PID lock without an instance id that was written after this process started', async () => {
    const withFileLock = await setup(`${process.pid}\n${Date.now()}\n`);
    let acquired = false;
    const p = withFileLock('test', async () => { acquired = true; });
    await new Promise(r => setTimeout(r, 300));
    expect(acquired).toBe(false);
    await fs.unlink(lockFile());
    await p;
  });

  it('records a per-process instance id and PID in the lockfile it writes', async () => {
    const withFileLock = await setup(`${process.pid}\n${beforeProcessStart()}\n`);
    await fs.unlink(lockFile());
    const seen: string[] = [];
    await withFileLock('test', async () => { seen.push(await fs.readFile(lockFile(), 'utf-8')); });
    await withFileLock('test', async () => { seen.push(await fs.readFile(lockFile(), 'utf-8')); });
    const [pid1, , id1] = seen[0].split('\n');
    const [, , id2] = seen[1].split('\n');
    expect(Number(pid1)).toBe(process.pid);
    expect(id1).toMatch(/^[0-9a-f-]{36}$/);
    expect(id2).toBe(id1);
  });

  it('reclaims a leftover lockfile of this very instance', async () => {
    const withFileLock = await setup(`${process.pid}\n${beforeProcessStart()}\n`);
    await fs.unlink(lockFile());
    // First acquire writes our instance id; simulate a crash that skipped the release.
    let content = '';
    await withFileLock('test', async () => { content = await fs.readFile(lockFile(), 'utf-8'); });
    await fs.writeFile(lockFile(), content.replace(/\n[^\n]*\n/, `\n${Date.now()}\n`), { mode: 0o600 });
    const started = Date.now();
    expect(await withFileLock('test', async () => 'ok')).toBe('ok');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('does not reclaim a lock held by a live other process', async () => {
    const withFileLock = await setup(`${process.ppid}\n${Date.now() - 3_600_000}\n`);
    let acquired = false;
    const p = withFileLock('test', async () => { acquired = true; });
    await new Promise(r => setTimeout(r, 400));
    expect(acquired).toBe(false);
    // Release the foreign lock so the pending acquire can finish.
    await fs.unlink(path.join(tmpRoot, 'data', '.locks', 'test.lock'));
    await p;
    expect(acquired).toBe(true);
  });

  it('still reclaims an old lockfile whose PID is dead', async () => {
    const withFileLock = await setup(`4194304\n${Date.now() - 3_600_000}\n`);
    expect(await withFileLock('test', async () => 'ok')).toBe('ok');
  });
});

describe('in-process lock wait deadline', () => {
  afterEach(() => { delete process.env.OVERWATCH_LOCK_TIMEOUT_MS; });

  async function load() {
    const dataDir = path.join(tmpRoot, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    vi.doMock('../config', () => ({ getDataDir: () => dataDir }));
    return import('../services/fileLock');
  }

  it('fails a queued in-process waiter with a 409 "busy" error instead of waiting forever', async () => {
    process.env.OVERWATCH_LOCK_TIMEOUT_MS = '150';
    const { withTenantLock } = await load();
    const { ConflictError } = await import('../utils/httpErrors');
    let releaseHolder!: () => void;
    const holder = withTenantLock('shop', 't1', () => new Promise<void>(r => { releaseHolder = r; }));
    await new Promise(r => setTimeout(r, 20));

    const started = Date.now();
    const waiter = withTenantLock('shop', 't1', async () => 'never');
    const err = await waiter.catch(e => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/Tenant 'shop\/t1' is busy/);
    expect(Date.now() - started).toBeLessThan(2000);

    // The holder is unaffected and the key is usable again after it finishes.
    releaseHolder();
    await holder;
    expect(await withTenantLock('shop', 't1', async () => 'ok')).toBe('ok');
  });

  it('a waiter that is released in time still runs', async () => {
    process.env.OVERWATCH_LOCK_TIMEOUT_MS = '2000';
    const { withFileLock } = await load();
    const order: string[] = [];
    const first = withFileLock('k', async () => { await new Promise(r => setTimeout(r, 80)); order.push('first'); });
    const second = withFileLock('k', async () => { order.push('second'); });
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });

  it('a lockfile held by another live process times out with the same 409 busy error', async () => {
    process.env.OVERWATCH_LOCK_TIMEOUT_MS = '200';
    const { withFileLock } = await load();
    const { ConflictError } = await import('../utils/httpErrors');
    await fs.mkdir(path.join(tmpRoot, 'data', '.locks'), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, 'data', '.locks', 'k.lock'), `${process.ppid}\n${Date.now()}\n`, { mode: 0o600 });
    const err = await withFileLock('k', async () => 'never').catch(e => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/busy/);
  });
});
