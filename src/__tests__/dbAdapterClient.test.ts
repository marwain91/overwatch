import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const spawnMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (orig) => {
  const actual = await orig<typeof import('child_process')>();
  return { ...actual, spawn: spawnMock, execFile: execFileMock };
});
vi.mock('pg', () => ({ Pool: class { on() {} end = vi.fn(async () => {}); } }));
vi.mock('mysql2/promise', () => ({ default: { createPool: vi.fn(() => ({ end: vi.fn(async () => {}) })) } }));

import { MySQLAdapter } from '../adapters/database/mysql';
import { PostgresAdapter } from '../adapters/database/postgres';
import type { DatabaseAdapterConfig } from '../adapters/database/types';

function cfg(type: 'mariadb' | 'postgres'): DatabaseAdapterConfig {
  return { type, host: 'db', port: 1, rootUser: 'root', rootPassword: 'pw', containerName: 'dbc', dbPrefix: 'p' };
}

/** A client that exits 0 right away (dumps write `body`). */
function okProc(body = '') {
  const proc: any = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.kill = vi.fn();
  setImmediate(() => { proc.stdout.end(body); proc.stderr.end(); setImmediate(() => proc.emit('close', 0)); });
  return proc;
}

/** A client that never exits until killed. */
function hungProc() {
  const proc: any = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.kill = vi.fn(() => { setImmediate(() => proc.emit('close', null, 'SIGKILL')); return true; });
  return proc;
}

let probeWorks = true;
let tmpDir: string;
let sqlFile: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-dbclient-'));
  sqlFile = path.join(tmpDir, 'in.sql');
  await fs.writeFile(sqlFile, 'select 1;');
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => okProc());
  execFileMock.mockReset();
  probeWorks = true;
  // The `timeout` probe inside the DB container.
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    if (probeWorks) cb(null, '', '');
    else cb(Object.assign(new Error('exec: "timeout": executable file not found in $PATH'), { code: 127 }), '', 'executable file not found');
    return { on: () => {} };
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.JWT_SECRET;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const adapters = [
  ['mysql', () => new MySQLAdapter(cfg('mariadb')), 'MYSQL_PWD'],
  ['postgres', () => new PostgresAdapter(cfg('postgres')), 'PGPASSWORD'],
] as const;

describe.each(adapters)('%s client processes', (_name, make, pwVar) => {
  it('do not inherit Overwatch secrets from process.env', async () => {
    process.env.JWT_SECRET = 'jwt-secret-value';
    const a = make();
    await a.dumpDatabase('t1', path.join(tmpDir, 'out.sql'));
    await a.restoreDatabase('t1', sqlFile);
    for (const [, , opts] of spawnMock.mock.calls) {
      expect(opts.env.JWT_SECRET).toBeUndefined();
      expect(opts.env[pwVar]).toBe('pw');
      expect(opts.env.PATH).toBe(process.env.PATH);
    }
  });

  it('run under `timeout` inside the DB container when it has one', async () => {
    const a = make();
    await a.dumpDatabase('t1', path.join(tmpDir, 'out.sql'));
    await a.restoreDatabase('t1', sqlFile);
    for (const [, args] of spawnMock.mock.calls) {
      const i = args.indexOf('dbc');
      expect(args.slice(i + 1, i + 5)).toEqual(['timeout', '-k', '30', '3600']);
    }
    // The probe runs once per adapter, not per dump.
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('still run (without the in-container timeout) when the DB container has no `timeout`', async () => {
    probeWorks = false;
    await make().dumpDatabase('t1', path.join(tmpDir, 'out.sql'));
    const [, args] = spawnMock.mock.calls[0];
    expect(args).not.toContain('timeout');
    expect(console.warn).toHaveBeenCalled();
  });

  it('kill a hung dump locally and reject', async () => {
    const a = make() as any;
    a.clientTimeoutMs = 20;
    a.localKillGraceMs = 10;
    const proc = hungProc();
    spawnMock.mockImplementation(() => proc);
    await expect(a.dumpDatabase('t1', path.join(tmpDir, 'out.sql'))).rejects.toThrow(/timed out/);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('kill a hung restore locally and reject', async () => {
    const a = make() as any;
    a.clientTimeoutMs = 20;
    a.localKillGraceMs = 10;
    const proc = hungProc();
    spawnMock.mockImplementation(() => proc);
    await expect(a.restoreDatabase('t1', sqlFile)).rejects.toThrow(/timed out/);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });
});

describe('client arguments', () => {
  const argsOf = (call: number) => spawnMock.mock.calls[call][1] as string[];

  it('mysqldump also dumps stored routines and events (triggers are on by default)', async () => {
    await new MySQLAdapter(cfg('mariadb')).dumpDatabase('t1', path.join(tmpDir, 'out.sql'));
    expect(argsOf(0)).toEqual(expect.arrayContaining(['mysqldump', '--single-transaction', '--routines', '--events', 'p_t1']));
    expect(argsOf(0)).not.toContain('--skip-triggers');
  });

  it('pg_dump leaves out owners and privileges', async () => {
    await new PostgresAdapter(cfg('postgres')).dumpDatabase('t1', path.join(tmpDir, 'out.sql'));
    expect(argsOf(0)).toEqual(expect.arrayContaining(['pg_dump', '--no-owner', '--no-privileges', '-d', 'p_t1']));
  });

  // Without ON_ERROR_STOP psql reports success after SQL errors. The objects of
  // a --no-owner dump belong to whoever creates them, so the restore runs as
  // the tenant's role; dumps from older versions name that same role in their
  // OWNER TO statements, which the role may run on its own objects.
  it('psql stops at the first error, in one transaction, as the tenant role', async () => {
    await new PostgresAdapter(cfg('postgres')).restoreDatabase('t1', sqlFile);
    const args = argsOf(0);
    expect(args).toEqual(expect.arrayContaining(['psql', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-d', 'p_t1']));
    const c = args.indexOf('-c');
    expect(args[c + 1]).toBe('SET ROLE "p_t1"');
    expect(args.slice(args.indexOf('-f'))).toEqual(['-f', '-']);
    expect(c).toBeLessThan(args.indexOf('-f'));
  });
});
