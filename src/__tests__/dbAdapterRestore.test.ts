import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough, Writable } from 'stream';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (orig) => {
  const actual = await orig<typeof import('child_process')>();
  // execFile only runs the probe for `timeout` in the DB container: report none.
  const execFile = (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(Object.assign(new Error('not available in tests'), { code: 127 }), '', '');
    return { on() {} };
  };
  return { ...actual, spawn: spawnMock, execFile };
});
vi.mock('pg', () => ({ Pool: class { on() {} end = vi.fn(async () => {}); } }));
vi.mock('mysql2/promise', () => ({ default: { createPool: vi.fn(() => ({ end: vi.fn(async () => {}) })) } }));

import { MySQLAdapter } from '../adapters/database/mysql';
import { PostgresAdapter } from '../adapters/database/postgres';
import type { DatabaseAdapterConfig } from '../adapters/database/types';

let tmpDir: string;
let sqlFile: string;

function cfg(type: 'mariadb' | 'postgres'): DatabaseAdapterConfig {
  return { type, host: 'db', port: 1, rootUser: 'root', rootPassword: 'x', containerName: 'dbc', dbPrefix: 'p' };
}

/** A client process that writes `stderr` and exits with `code`. */
function failingProc(stderr: string, code: number) {
  const proc: any = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  setImmediate(() => { proc.stderr.write(stderr); proc.stderr.end(); setImmediate(() => proc.emit('close', code)); });
  return proc;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-restore-'));
  sqlFile = path.join(tmpDir, 'in.sql');
  await fs.writeFile(sqlFile, 'select 1;');
  spawnMock.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe.each([
  ['mysql', () => new MySQLAdapter(cfg('mariadb'))],
  ['postgres', () => new PostgresAdapter(cfg('postgres'))],
] as const)('%s restoreDatabase failure message', (_name, make) => {
  it('keeps only the last 2 KB of stderr', async () => {
    const noise = 'NOISE-LINE\n'.repeat(5000);
    spawnMock.mockImplementation(() => failingProc(`${noise}FATAL: the real reason`, 1));
    const err = (await make().restoreDatabase('t1', sqlFile).then(() => null, (e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('FATAL: the real reason');
    expect(err.message.length).toBeLessThan(2048 + 200);
  });

  it('passes a short stderr through unchanged', async () => {
    spawnMock.mockImplementation(() => failingProc('ERROR 1045: access denied', 1));
    await expect(make().restoreDatabase('t1', sqlFile)).rejects.toThrow('ERROR 1045: access denied');
  });
});

/** A client that stops reading stdin (EPIPE on write), then exits with `code`. */
function earlyExitProc(stderr: string, code: number) {
  const proc: any = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new Writable({
    write(_chunk, _enc, cb) { cb(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })); },
  });
  proc.kill = vi.fn();
  setTimeout(() => { proc.stderr.end(stderr); setImmediate(() => proc.emit('close', code)); }, 20);
  return proc;
}

/** A client that writes `body` to stdout and exits 0. */
function dumpingProc(body: string) {
  const proc: any = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  setImmediate(() => { proc.stdout.end(body); proc.stderr.end(); setImmediate(() => proc.emit('close', 0)); });
  return proc;
}

describe.each([
  ['mysql', () => new MySQLAdapter(cfg('mariadb'))],
  ['postgres', () => new PostgresAdapter(cfg('postgres'))],
] as const)('%s dump/restore stream errors', (_name, make) => {
  it('rejects with the client error when the client exits while the dump is still streaming', async () => {
    await fs.writeFile(sqlFile, 'insert into t values (1);\n'.repeat(20_000));
    spawnMock.mockImplementation(() => earlyExitProc('ERROR 1273: Unknown collation', 1));
    await expect(make().restoreDatabase('t1', sqlFile)).rejects.toThrow('Unknown collation');
  });

  it('rejects and kills the client when the dump file cannot be read', async () => {
    const proc = earlyExitProc('', 0);
    spawnMock.mockImplementation(() => proc);
    await expect(make().restoreDatabase('t1', path.join(tmpDir, 'missing.sql'))).rejects.toThrow(/ENOENT/);
    expect(proc.kill).toHaveBeenCalled();
  });

  it('resolves a dump only once the file is fully written', async () => {
    const body = 'INSERT INTO t VALUES (1);\n'.repeat(50_000);
    spawnMock.mockImplementation(() => dumpingProc(body));
    const out = path.join(tmpDir, 'out.sql');
    await make().dumpDatabase('t1', out);
    expect(await fs.readFile(out, 'utf-8')).toBe(body);
  });

  it('kills the dump client when the output file cannot be written', async () => {
    const proc = dumpingProc('x');
    spawnMock.mockImplementation(() => proc);
    await expect(make().dumpDatabase('t1', path.join(tmpDir, 'no-such-dir', 'out.sql'))).rejects.toThrow(/ENOENT/);
    expect(proc.kill).toHaveBeenCalled();
  });
});
