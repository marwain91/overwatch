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
// Every dump file read stream, to check it is closed when a restore fails.
const readStreams = vi.hoisted(() => [] as Array<{ destroyed: boolean }>);
vi.mock('fs', async (orig) => {
  const actual = await orig<typeof import('fs')>();
  return {
    ...actual,
    createReadStream: (...a: Parameters<typeof actual.createReadStream>) => {
      const s = actual.createReadStream(...a);
      readStreams.push(s);
      return s;
    },
  };
});
vi.mock('pg', () => ({ Pool: class { on() {} end = vi.fn(async () => {}); } }));
vi.mock('mysql2/promise', () => ({ default: { createPool: vi.fn(() => ({ end: vi.fn(async () => {}) })) } }));

import { MySQLAdapter } from '../adapters/database/mysql';
import { PostgresAdapter, stripOwnerStatements, OWNER_FILTER_LINE_CAP } from '../adapters/database/postgres';
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
    // Pass a password so the restore's password-via-env path is exercised for both engines.
    await a.restoreDatabase('t1', sqlFile, { password: 'pw' });
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

  it('kill a hung restore locally, reject and close the dump file', async () => {
    const a = make() as any;
    a.clientTimeoutMs = 20;
    a.localKillGraceMs = 10;
    const proc = hungProc();
    spawnMock.mockImplementation(() => proc);
    readStreams.length = 0;
    // Large enough that the pipe is still waiting on the (hung) client.
    await fs.writeFile(sqlFile, 'insert into t values (1);\n'.repeat(200_000));
    await expect(a.restoreDatabase('t1', sqlFile)).rejects.toThrow(/timed out/);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    expect(readStreams).toHaveLength(1);
    expect(readStreams[0].destroyed).toBe(true);
  });

  it('refuse an unsafe database identifier without starting a client', async () => {
    await expect(make().dumpDatabase('T1;x', path.join(tmpDir, 'out.sql'))).rejects.toThrow(/Unsafe/);
    await expect(make().restoreDatabase('T1;x', sqlFile)).rejects.toThrow(/Unsafe/);
    expect(spawnMock).not.toHaveBeenCalled();
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

  // Without ON_ERROR_STOP psql reports success after SQL errors. The dump must
  // run as the tenant role, not a superuser: a --no-owner dump's objects then
  // belong to (and its index/CHECK code runs as) the tenant, so tenant content
  // cannot execute with superuser rights.
  it('connects as the tenant role (not a superuser), in one transaction with ON_ERROR_STOP', async () => {
    await new PostgresAdapter(cfg('postgres')).restoreDatabase('t1', sqlFile);
    const args = argsOf(0);
    // psql logs in AS the tenant role: no superuser session, no SET ROLE to escape from.
    expect(args).toEqual(expect.arrayContaining(['psql', '-U', 'p_t1', '-d', 'p_t1', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', '-']));
    expect(args.join(' ')).not.toMatch(/SET ROLE|SET SESSION|SUPERUSER|CREATE ROLE/i);
    expect(args).not.toContain('-c');
    // Without a password the container's local trust auth is used; no env is leaked.
    expect(spawnMock.mock.calls[0][2].env.PGPASSWORD).toBeUndefined();
  });

  it('passes the tenant DB password via env, not argv, when one is given', async () => {
    await new PostgresAdapter(cfg('postgres')).restoreDatabase('t1', sqlFile, { password: 'tenant-pw' });
    const [, args, opts] = spawnMock.mock.calls[0];
    expect(args).toContain('PGPASSWORD');
    expect(args.join(' ')).not.toContain('tenant-pw');
    expect(opts.env.PGPASSWORD).toBe('tenant-pw');
  });

});

describe('Postgres restore strips OWNER TO lines from old dumps', () => {
  /** A client that reads all of stdin, then exits 0; resolves with what it read. */
  function collectingProc(): { proc: any; stdin: Promise<string> } {
    const proc: any = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.stdin = new PassThrough();
    proc.kill = vi.fn();
    const stdin = new Promise<string>((resolve) => {
      let data = '';
      proc.stdin.on('data', (d: Buffer) => { data += d.toString(); });
      proc.stdin.on('finish', () => { proc.stdout.end(); setImmediate(() => proc.emit('close', 0)); resolve(data); });
    });
    return { proc, stdin };
  }

  async function restoreOf(dump: string): Promise<string> {
    const file = path.join(tmpDir, 'dump.sql');
    await fs.writeFile(file, dump);
    const { proc, stdin } = collectingProc();
    spawnMock.mockImplementation(() => proc);
    await new PostgresAdapter(cfg('postgres')).restoreDatabase('t1', file);
    return stdin;
  }

  it('drops top-level ALTER ... OWNER TO lines, keeps the rest', async () => {
    const out = await restoreOf([
      'CREATE TABLE public.items (id integer);',
      'ALTER TABLE public.items OWNER TO alice;',
      'ALTER SEQUENCE public.items_id_seq OWNER TO alice;',
      'ALTER FUNCTION public.f() OWNER TO alice;',
      'ALTER SCHEMA app OWNER TO alice;',
      'INSERT INTO public.items VALUES (1);',
    ].join('\n') + '\n');
    expect(out).not.toMatch(/OWNER TO/);
    expect(out).toContain('CREATE TABLE public.items (id integer);');
    expect(out).toContain('INSERT INTO public.items VALUES (1);');
  });

  it('never touches an OWNER TO inside a dollar-quoted function body', async () => {
    const body = [
      "CREATE FUNCTION public.note() RETURNS text LANGUAGE plpgsql AS $body$",
      'BEGIN',
      "  -- this comment says ALTER TABLE x OWNER TO mallory; and is just text",
      "  RETURN 'ALTER TABLE y OWNER TO mallory;';",
      'END',
      '$body$;',
    ].join('\n');
    const out = await restoreOf(`${body}\nALTER FUNCTION public.note() OWNER TO alice;\n`);
    expect(out).toContain('ALTER TABLE x OWNER TO mallory;');
    expect(out).toContain("RETURN 'ALTER TABLE y OWNER TO mallory;';");
    // The real ownership statement after the body is still dropped.
    expect(out).not.toMatch(/ALTER FUNCTION public\.note\(\) OWNER TO alice;/);
  });

  it('a --no-owner dump (no OWNER TO lines) passes through unchanged', async () => {
    const dump = 'CREATE TABLE t (id int);\nINSERT INTO t VALUES (1);\n';
    expect(await restoreOf(dump)).toBe(dump);
  });
});



describe('stripOwnerStatements (COPY-aware, memory-bounded owner filter)', () => {
  /** Run `input` through the filter and return everything it emits. */
  function through(chunks: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const t = stripOwnerStatements();
      let out = '';
      t.on('data', (d: Buffer) => { out += d.toString(); });
      t.on('end', () => resolve(out));
      t.on('error', reject);
      for (const c of chunks) t.write(c);
      t.end();
    });
  }

  it('drops top-level OWNER TO lines and keeps everything else', async () => {
    const out = await through([
      'CREATE TABLE public.items (id integer);\n',
      'ALTER TABLE public.items OWNER TO alice;\n',
      'ALTER SEQUENCE public.s OWNER TO alice;\n',
      'INSERT INTO public.items VALUES (1);\n',
    ]);
    expect(out).not.toMatch(/OWNER TO/);
    expect(out).toContain('CREATE TABLE public.items (id integer);');
    expect(out).toContain('INSERT INTO public.items VALUES (1);');
  });

  it('leaves OWNER TO inside a dollar-quoted function body untouched', async () => {
    const dump = [
      'CREATE FUNCTION public.note() RETURNS text LANGUAGE plpgsql AS $body$',
      'BEGIN',
      "  RETURN 'ALTER TABLE y OWNER TO mallory;';",
      'END',
      '$body$;',
      'ALTER FUNCTION public.note() OWNER TO alice;',
    ].join('\n') + '\n';
    const out = await through([dump]);
    expect(out).toContain("RETURN 'ALTER TABLE y OWNER TO mallory;';");
    expect(out).not.toMatch(/ALTER FUNCTION public\.note\(\) OWNER TO alice;/);
  });

  it('passes COPY data through untouched: a row that looks like an owner statement is kept', async () => {
    const dump = [
      'COPY public.t (body) FROM stdin;',
      'ALTER TABLE public.t OWNER TO alice;',
      '\\.',
      'ALTER TABLE public.t OWNER TO alice;',
    ].join('\n') + '\n';
    const out = await through([dump]);
    expect(out).toContain('COPY public.t (body) FROM stdin;');
    expect(out.match(/ALTER TABLE public\.t OWNER TO alice;/g)).toHaveLength(1);
    expect(out).toContain('\\.\n');
  });

  it('does not track dollar quotes inside COPY data (a $$ in a row cannot desync the parser)', async () => {
    const dump = [
      'COPY public.t (body) FROM stdin;',
      'a value with $$ in it',
      '\\.',
      'ALTER TABLE public.t OWNER TO alice;',
    ].join('\n') + '\n';
    const out = await through([dump]);
    expect(out).toContain('a value with $$ in it');
    expect(out).not.toMatch(/OWNER TO/);
  });

  it('streams a huge single COPY row without buffering it whole', async () => {
    const t = stripOwnerStatements();
    let emitted = 0;
    t.on('data', (d: Buffer) => { emitted += d.length; });
    const drained = new Promise((r) => t.on('end', r));

    t.write('COPY public.t (body) FROM stdin;\n');
    const CHUNK = 64 * 1024;
    const ROW_BYTES = 50 * 1024 * 1024;
    const piece = 'x'.repeat(CHUNK);
    for (let written = 0; written < ROW_BYTES; written += CHUNK) t.write(piece);
    // The row's newline has NOT been written yet: a buffering filter would be
    // holding all 50 MB. Assert it already streamed almost all of it out.
    expect(emitted).toBeGreaterThan(ROW_BYTES - 4 * OWNER_FILTER_LINE_CAP);

    t.write('\n\\.\n');
    t.end();
    await drained;
  });

  it('a long non-COPY line is streamed through, not dropped', async () => {
    const long = 'SELECT ' + "'" + 'a'.repeat(OWNER_FILTER_LINE_CAP * 2) + "'" + ';';
    const out = await through([long + '\n']);
    expect(out.length).toBeGreaterThanOrEqual(long.length);
  });

  it('a --no-owner dump passes through unchanged', async () => {
    const dump = 'CREATE TABLE t (id int);\nINSERT INTO t VALUES (1);\n';
    expect(await through([dump])).toBe(dump);
  });
});
