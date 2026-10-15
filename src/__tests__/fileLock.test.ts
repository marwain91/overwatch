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
    const lock = path.join(dataDir, '.locks', 'test.lock');
    await fs.writeFile(lock, '4194304\n0\n', { mode: 0o600 });
    // Staleness is judged by mtime (holders refresh it), so age the file itself.
    const old = new Date(Date.now() - 3_600_000);
    await fs.utimes(lock, old, old);
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
    const old = new Date(Date.now() - 3_600_000);
    await fs.utimes(lockFile(), old, old);
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

describe('withFileLock per-call wait', () => {
  async function loadLock() {
    const dataDir = path.join(tmpRoot, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    vi.doMock('../config', () => ({ getDataDir: () => dataDir }));
    return import('../services/fileLock');
  }

  it('waitMs overrides the default wait and times out with the 409 busy error', async () => {
    delete process.env.OVERWATCH_LOCK_TIMEOUT_MS;
    const { withFileLock } = await loadLock();
    const { ConflictError } = await import('../utils/httpErrors');
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const holder = withFileLock('k', () => gate);
    const started = Date.now();
    const err = await withFileLock('k', async () => 'never', { waitMs: 60 }).catch(e => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(Date.now() - started).toBeLessThan(5_000);
    release();
    await holder;
  });

  it('unref keeps the waiting timers from holding the process open', async () => {
    const { withFileLock } = await loadLock();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const holder = withFileLock('k', () => gate);
    const real = global.setTimeout;
    const timers: Array<{ ms: number; t: any }> = [];
    const spy = vi.spyOn(global, 'setTimeout').mockImplementation(((fn: any, ms?: number, ...rest: any[]) => {
      const t = real(fn, ms, ...rest);
      timers.push({ ms: ms ?? 0, t });
      return t;
    }) as any);
    const waiter = withFileLock('k', async () => 'ok', { waitMs: 5_000, unref: true });
    await new Promise(r => real(r, 30));
    const waiting = timers.filter(x => x.ms >= 1_000);
    spy.mockRestore();
    expect(waiting.length).toBeGreaterThan(0);
    for (const x of waiting) expect(x.t.hasRef()).toBe(false);
    release();
    await holder;
    expect(await waiter).toBe('ok');
  });
});

describe('lockfile ownership, heartbeat and bounded reclaim', () => {
  afterEach(() => {
    delete process.env.OVERWATCH_LOCK_TIMEOUT_MS;
    vi.doUnmock('fs/promises');
    vi.useRealTimers();
  });

  const lockFile = (key = 'k') => path.join(tmpRoot, 'data', '.locks', `${key}.lock`);
  const ageFile = async (file: string, ms: number) => {
    const t = new Date(Date.now() - ms);
    await fs.utimes(file, t, t);
  };

  async function load(content?: string) {
    const dataDir = path.join(tmpRoot, 'data');
    await fs.mkdir(path.join(dataDir, '.locks'), { recursive: true });
    if (content !== undefined) await fs.writeFile(lockFile(), content, { mode: 0o600 });
    vi.doMock('../config', () => ({ getDataDir: () => dataDir }));
    return import('../services/fileLock');
  }

  it('does not reclaim a lock whose holder keeps its mtime fresh, even when its PID is not visible here', async () => {
    // A host CLI holding a lock: its PID does not exist in the container's
    // namespace and it acquired over a minute ago, but it is alive (heartbeat).
    process.env.OVERWATCH_LOCK_TIMEOUT_MS = '300';
    const foreign = `4194304\n${Date.now() - 3_600_000}\nhost-cli-instance\n`;
    const { withFileLock } = await load(foreign);
    const { ConflictError } = await import('../utils/httpErrors');
    const err = await withFileLock('k', async () => 'stolen').catch(e => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(await fs.readFile(lockFile(), 'utf-8')).toBe(foreign);
  });

  it('refreshes the lockfile mtime while the lock is held', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { withFileLock } = await load();
    let refreshedMs = 0;
    await withFileLock('k', async () => {
      await ageFile(lockFile(), 120_000);
      vi.advanceTimersByTime(60_000);
      // The refresh is real file I/O; give it a moment to land.
      for (let i = 0; i < 50 && Date.now() - (await fs.stat(lockFile())).mtimeMs > 60_000; i++) {
        await new Promise(r => setTimeout(r, 10));
      }
      refreshedMs = Date.now() - (await fs.stat(lockFile())).mtimeMs;
    });
    expect(refreshedMs).toBeLessThan(60_000);
  });

  it('release leaves alone a lockfile that is no longer ours', async () => {
    const { withFileLock } = await load();
    const foreign = `4194304\n${Date.now()}\nnext-holder\nnext-token\n`;
    await withFileLock('k', async () => {
      // Our lock was reclaimed and another holder now owns the path.
      await fs.unlink(lockFile());
      await fs.writeFile(lockFile(), foreign, { mode: 0o600 });
    });
    expect(await fs.readFile(lockFile(), 'utf-8')).toBe(foreign);
  });

  it('a reclaimer never removes a live lock that replaced the stale one it inspected', async () => {
    process.env.OVERWATCH_LOCK_TIMEOUT_MS = '300';
    // Another reclaimer wins the race: between our staleness check and our
    // claim, the stale file is replaced by its fresh, live lock.
    const live = `${process.ppid}\n${Date.now()}\nwinner-instance\nwinner-token\n`;
    let swapped = false;
    vi.doMock('fs/promises', async () => {
      const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
      const swapFirst = <A extends unknown[], R>(op: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
        if (!swapped && String(a[0]) === lockFile()) {
          swapped = true;
          await actual.unlink(lockFile());
          await actual.writeFile(lockFile(), live, { mode: 0o600 });
        }
        return op(...a);
      };
      return { ...actual, unlink: swapFirst(actual.unlink), rename: swapFirst(actual.rename) };
    });
    const { withFileLock } = await load(`4194304\n0\ncrashed-instance\n`);
    await ageFile(lockFile(), 3_600_000);
    const { ConflictError } = await import('../utils/httpErrors');
    const err = await withFileLock('k', async () => 'double-held').catch(e => e);
    expect(swapped).toBe(true);
    expect(err).toBeInstanceOf(ConflictError);
    expect(await fs.readFile(lockFile(), 'utf-8')).toBe(live);
  });

  it('gives up within the wait when a stale lockfile cannot be removed', async () => {
    process.env.OVERWATCH_LOCK_TIMEOUT_MS = '300';
    vi.doMock('fs/promises', async () => {
      const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
      const denied = async () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); };
      return { ...actual, unlink: denied, rename: denied };
    });
    const { withFileLock } = await load(`4194304\n0\ncrashed-instance\n`);
    await ageFile(lockFile(), 3_600_000);
    const started = Date.now();
    const err = await withFileLock('k', async () => 'never').catch(e => e);
    expect(err?.status).toBe(409);
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 8_000);
});
