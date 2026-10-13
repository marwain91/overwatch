import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (orig) => {
  const actual = await orig<typeof import('child_process')>();
  return { ...actual, spawn: spawnMock };
});

const poolCtor = vi.hoisted(() => vi.fn());
vi.mock('pg', () => ({
  Pool: class {
    constructor(opts: unknown) { poolCtor(opts); }
    on() {}
    end = vi.fn(async () => {});
  },
}));
const mysqlCreatePool = vi.hoisted(() => vi.fn(() => ({ end: vi.fn(async () => {}) })));
vi.mock('mysql2/promise', () => ({ default: { createPool: mysqlCreatePool } }));

import { MySQLAdapter } from '../adapters/database/mysql';
import { PostgresAdapter } from '../adapters/database/postgres';
import { closeAllDatabaseAdapters, getDatabaseAdapter } from '../adapters/database';
import type { DatabaseAdapterConfig } from '../adapters/database/types';
import * as configModule from '../config';

const SECRET = 'S3cr3t-root-pw';

function makeConfig(type: 'mariadb' | 'postgres'): DatabaseAdapterConfig {
  return {
    type, host: 'db', port: type === 'postgres' ? 5432 : 3306,
    rootUser: 'root', rootPassword: SECRET, containerName: 'dbc', dbPrefix: 'p',
  };
}

function fakeProc() {
  const proc: any = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  setImmediate(() => { proc.stdout.end(); proc.emit('close', 0); });
  return proc;
}

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => fakeProc());
  poolCtor.mockClear();
  mysqlCreatePool.mockClear();
});

describe('root password never appears in docker exec argv', () => {
  const cases: Array<[string, 'mariadb' | 'postgres', string]> = [
    ['mysql', 'mariadb', 'MYSQL_PWD'],
    ['postgres', 'postgres', 'PGPASSWORD'],
  ];
  for (const [name, type, envVar] of cases) {
    const make = () => (type === 'postgres'
      ? new PostgresAdapter(makeConfig(type))
      : new MySQLAdapter(makeConfig(type)));

    it(`${name} dump passes ${envVar} by name and supplies the value via env`, async () => {
      await make().dumpDatabase('t1', '/tmp/overwatch-hardening-dump.sql');
      const [cmd, args, opts] = spawnMock.mock.calls[0];
      expect(cmd).toBe('docker');
      expect(args.join(' ')).not.toContain(SECRET);
      expect(args).toContain(envVar);
      expect(opts.env[envVar]).toBe(SECRET);
    });

    it(`${name} restore passes ${envVar} by name and supplies the value via env`, async () => {
      const f = '/tmp/overwatch-hardening-restore.sql';
      await (await import('fs/promises')).writeFile(f, 'select 1;');
      await make().restoreDatabase('t1', f);
      const [, args, opts] = spawnMock.mock.calls[0];
      expect(args.join(' ')).not.toContain(SECRET);
      expect(args).toContain(envVar);
      expect(opts.env[envVar]).toBe(SECRET);
    });
  }
});

describe('Postgres createDatabase restricts CONNECT', () => {
  async function run(dbExists: boolean) {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return { rows: sql.includes('FROM pg_database') && dbExists ? [{ '?column?': 1 }] : [] };
      }),
      release: vi.fn(),
    };
    const adapter = new PostgresAdapter(makeConfig('postgres'));
    (adapter as any).pool = { connect: vi.fn(async () => client) };
    await adapter.createDatabase('t1', 'pw');
    return queries;
  }

  for (const exists of [false, true]) {
    it(`revokes PUBLIC and grants the tenant role (database exists: ${exists})`, async () => {
      const q = await run(exists);
      expect(q).toContain('REVOKE CONNECT ON DATABASE "p_t1" FROM PUBLIC');
      expect(q).toContain('GRANT CONNECT ON DATABASE "p_t1" TO "p_t1"');
    });
  }
});

describe('pool options', () => {
  it('pg pool has connect/idle/statement timeouts', () => {
    (new PostgresAdapter(makeConfig('postgres')) as any).createPool();
    expect(poolCtor).toHaveBeenCalledWith(expect.objectContaining({
      connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, statement_timeout: 30000,
    }));
  });

  it('mysql pool has connectTimeout and queueLimit', () => {
    (new MySQLAdapter(makeConfig('mariadb')) as any).createPool();
    expect(mysqlCreatePool).toHaveBeenCalledWith(expect.objectContaining({
      connectTimeout: 10000, queueLimit: 50,
    }));
  });
});

describe('closeAllDatabaseAdapters', () => {
  it('closes every cached adapter, swallows errors and empties the cache', async () => {
    const cfg: any = {
      database: { type: 'postgres', host: 'db', port: 5432, root_user: 'r', root_password: 'x', container_name: 'c' },
      project: { db_prefix: 'a' },
    };
    vi.spyOn(configModule, 'loadConfig').mockReturnValue(cfg);
    const a = getDatabaseAdapter({ db_prefix: 'one' } as any);
    const b = getDatabaseAdapter({ db_prefix: 'two' } as any);
    const closeA = vi.spyOn(a, 'close').mockRejectedValue(new Error('boom'));
    const closeB = vi.spyOn(b, 'close').mockResolvedValue();
    await expect(closeAllDatabaseAdapters()).resolves.toBeUndefined();
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).toHaveBeenCalledTimes(1);
    expect(getDatabaseAdapter({ db_prefix: 'one' } as any)).not.toBe(a);
    vi.restoreAllMocks();
  });
});
