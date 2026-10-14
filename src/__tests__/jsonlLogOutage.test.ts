import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let dir: string;
let file: string;
let writable: boolean;
let appendCalls: number;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-jsonl-outage-'));
  file = path.join(dir, 'audit.log');
  writable = false;
  appendCalls = 0;
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  // The outage is simulated at appendFile so everything stays on fake timers.
  vi.doMock('fs/promises', () => {
    const appendFile = (async (...args: Parameters<typeof actual.appendFile>) => {
      appendCalls++;
      if (!writable) throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
      return actual.appendFile(...args);
    }) as typeof actual.appendFile;
    return { ...actual, appendFile, default: { ...actual, appendFile } };
  });
  vi.doMock('../config', () => ({ getDataDir: () => dir }));
  vi.doMock('../services/fileLock', () => ({ withFileLock: async (_k: string, fn: () => Promise<unknown>) => fn() }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  for (const m of ['fs/promises', '../config', '../services/fileLock']) vi.doUnmock(m);
  await fs.rm(dir, { recursive: true, force: true });
});

const errorCalls = () => (console.error as any).mock.calls.map((c: any[]) => String(c[0])) as string[];

describe('JsonlLog during a write outage', () => {
  it('stops retrying after a bounded number of attempts, logging the outage once', async () => {
    vi.useFakeTimers();
    const { JsonlLog } = await import('../utils/jsonlLog');
    const log = new JsonlLog(() => file, 'test');

    log.append('one');
    await vi.advanceTimersByTimeAsync(20_000); // the 1s+2s+4s+8s backoff finishes inside this

    expect(appendCalls).toBe(5); // bounded: it gave up instead of retrying forever
    expect(errorCalls().filter(m => m.includes('write failed'))).toHaveLength(1);

    // More appends inside the cooldown do not start new retry storms.
    await vi.advanceTimersByTimeAsync(10_000);
    log.append('two');
    log.append('three');
    await vi.advanceTimersByTimeAsync(0);
    expect(appendCalls).toBe(5);

    // The chain is free: a flush makes one forced attempt and returns.
    const flushed = log.flush();
    await vi.advanceTimersByTimeAsync(0);
    await expect(flushed).resolves.toBeUndefined();
    expect(appendCalls).toBe(6);
  });

  it('delivers every queued entry, in order, once the file is writable again', async () => {
    vi.useFakeTimers();
    const { JsonlLog } = await import('../utils/jsonlLog');
    const log = new JsonlLog(() => file, 'test');
    log.append('one');
    log.append('two');
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    writable = true;
    vi.useRealTimers();
    log.append('three');
    await log.flush();
    expect((await fs.readFile(file, 'utf-8')).split('\n').filter(Boolean)).toEqual(['one', 'two', 'three']);
  });

  it('caps the entries held in memory while unwritable and says so', async () => {
    vi.useFakeTimers();
    const { JsonlLog } = await import('../utils/jsonlLog');
    const log = new JsonlLog(() => file, 'test');
    for (let i = 0; i < 10_050; i++) log.append(`line ${i}`);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect((log as any).queue.length).toBeLessThanOrEqual(10_000);
    // Oldest dropped, newest kept.
    expect((log as any).queue.at(-1)).toBe('line 10049\n');
    expect(errorCalls().some(m => m.includes('dropped'))).toBe(true);
  });

  it('enforces the cap at append time too, during the cooldown', async () => {
    vi.useFakeTimers();
    const { JsonlLog } = await import('../utils/jsonlLog');
    const log = new JsonlLog(() => file, 'test');
    log.append('first');
    await vi.advanceTimersByTimeAsync(20_000); // gave up; cooldown active
    const callsBefore = appendCalls;
    for (let i = 0; i < 10_100; i++) log.append(`line ${i}`);
    expect((log as any).queue.length).toBeLessThanOrEqual(10_000); // no waiting for a failed drain
    expect((log as any).queue.at(-1)).toBe('line 10099\n');
    expect(appendCalls).toBe(callsBefore);
    expect(errorCalls().filter(m => m.includes('dropped'))).toHaveLength(1); // logged once
  });

  it('a failed forced flush logs how many lines were not written, even after the outage was logged', async () => {
    vi.useFakeTimers();
    const { JsonlLog } = await import('../utils/jsonlLog');
    const log = new JsonlLog(() => file, 'test');
    log.append('one');
    log.append('two');
    await vi.advanceTimersByTimeAsync(20_000);
    const flushed = log.flush();
    await vi.advanceTimersByTimeAsync(0);
    await flushed;
    expect(errorCalls().some(m => /2 queued line\(s\) not written/.test(m))).toBe(true);
  });
});
