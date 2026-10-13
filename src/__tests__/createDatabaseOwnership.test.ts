import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as util from 'util';

vi.mock('pg', () => ({
  Pool: class { on() {} end = vi.fn(async () => {}); },
}));
vi.mock('mysql2/promise', () => ({ default: { createPool: vi.fn(() => ({ end: vi.fn(async () => {}) })) } }));

import { MySQLAdapter } from '../adapters/database/mysql';
import { PostgresAdapter } from '../adapters/database/postgres';
import type { DatabaseAdapterConfig } from '../adapters/database/types';

function cfg(type: 'mariadb' | 'postgres'): DatabaseAdapterConfig {
  return { type, host: 'db', port: 1, rootUser: 'root', rootPassword: 'x', containerName: 'dbc', dbPrefix: 'p' };
}

/** Fake connection: `exists` decides rows for existence probes; `failOn` makes a matching statement throw. */
function fakeConn(opts: { dbExists?: boolean; userExists?: boolean; failOn?: string }) {
  const queries: string[] = [];
  const query = vi.fn(async (sql: string) => {
    queries.push(sql);
    if (opts.failOn && sql.includes(opts.failOn)) throw new Error('boom');
    if (sql.includes('information_schema.SCHEMATA') || sql.includes('FROM pg_database')) {
      return [opts.dbExists ? [{ x: 1 }] : [], undefined] as any;
    }
    if (sql.includes('mysql.user') || sql.includes('FROM pg_roles')) {
      return [opts.userExists ? [{ x: 1 }] : [], undefined] as any;
    }
    return [[], undefined] as any;
  });
  return { queries, query, release: vi.fn() };
}

// pg returns { rows }, mysql returns [rows]; adapt the fake for pg.
function pgConn(opts: Parameters<typeof fakeConn>[0]) {
  const inner = fakeConn(opts);
  const query = vi.fn(async (sql: string) => {
    const r = await inner.query(sql);
    return { rows: r[0] };
  });
  return { queries: inner.queries, query, release: vi.fn() };
}

describe('mysql createDatabase ownership', () => {
  function make(conn: ReturnType<typeof fakeConn>) {
    const a = new MySQLAdapter(cfg('mariadb'));
    (a as any).pool = { getConnection: vi.fn(async () => conn), query: conn.query };
    return a;
  }

  it('reports what it created', async () => {
    const r = await make(fakeConn({})).createDatabase('t1', 'pw');
    expect(r).toEqual({ created: true, userCreated: true });
  });

  it('reports created:false when the database already exists', async () => {
    const r = await make(fakeConn({ dbExists: true })).createDatabase('t1', 'pw');
    expect(r.created).toBe(false);
  });

  it('sets the password with ALTER USER when the user exists but the database did not', async () => {
    const conn = fakeConn({ userExists: true });
    const r = await make(conn).createDatabase('t1', 'pw');
    expect(r).toEqual({ created: true, userCreated: false });
    expect(conn.queries.some(q => q.startsWith("ALTER USER 'p_t1'@'%' IDENTIFIED BY"))).toBe(true);
    expect(conn.queries.some(q => q.startsWith('CREATE USER'))).toBe(false);
  });

  it('on partial failure drops only what this call created', async () => {
    const conn = fakeConn({ userExists: true, failOn: 'GRANT ALL' });
    await expect(make(conn).createDatabase('t1', 'pw')).rejects.toThrow('boom');
    expect(conn.queries).toContain('DROP DATABASE IF EXISTS `p_t1`');
    expect(conn.queries.some(q => q.startsWith('DROP USER'))).toBe(false);
  });

  it('on partial failure never drops a pre-existing database', async () => {
    const conn = fakeConn({ dbExists: true, failOn: 'CREATE USER' });
    await expect(make(conn).createDatabase('t1', 'pw')).rejects.toThrow('boom');
    expect(conn.queries.some(q => q.startsWith('DROP'))).toBe(false);
  });

  it('dropDatabase keepUser leaves the user', async () => {
    const conn = fakeConn({});
    await make(conn).dropDatabase('t1', { keepUser: true });
    expect(conn.queries.some(q => q.startsWith('DROP USER'))).toBe(false);
  });
});

describe('postgres createDatabase ownership', () => {
  function make(conn: ReturnType<typeof pgConn>) {
    const a = new PostgresAdapter(cfg('postgres'));
    (a as any).pool = { connect: vi.fn(async () => conn), query: conn.query };
    return a;
  }

  it('reports what it created', async () => {
    expect(await make(pgConn({})).createDatabase('t1', 'pw')).toEqual({ created: true, userCreated: true });
    expect(await make(pgConn({ dbExists: true, userExists: true })).createDatabase('t1', 'pw'))
      .toEqual({ created: false, userCreated: false });
  });

  it('on partial failure drops only what this call created', async () => {
    const conn = pgConn({ userExists: true, failOn: 'GRANT ALL' });
    await expect(make(conn).createDatabase('t1', 'pw')).rejects.toThrow('boom');
    expect(conn.queries).toContain('DROP DATABASE IF EXISTS "p_t1"');
    expect(conn.queries.some(q => q.startsWith('DROP USER'))).toBe(false);
  });

  it('on partial failure never drops a pre-existing database', async () => {
    const conn = pgConn({ dbExists: true, failOn: 'GRANT ALL' });
    await expect(make(conn).createDatabase('t1', 'pw')).rejects.toThrow('boom');
    expect(conn.queries.some(q => q.startsWith('DROP DATABASE'))).toBe(false);
    expect(conn.queries).toContain('DROP USER IF EXISTS "p_t1"');
  });

  it('dropDatabase lifts statement_timeout for the drop and resets it before release', async () => {
    const conn = pgConn({});
    await make(conn).dropDatabase('t1');
    const iSet = conn.queries.indexOf('SET statement_timeout = 0');
    const iDrop = conn.queries.findIndex(q => q.startsWith('DROP DATABASE'));
    const iReset = conn.queries.indexOf('RESET statement_timeout');
    expect(iSet).toBeGreaterThanOrEqual(0);
    expect(iSet).toBeLessThan(iDrop);
    expect(iReset).toBeGreaterThan(iDrop);
    expect(conn.release).toHaveBeenCalledWith(undefined);
  });

  it('dropDatabase discards the client when the timeout reset fails', async () => {
    const conn = pgConn({ failOn: 'RESET statement_timeout' });
    await make(conn).dropDatabase('t1');
    expect(conn.release).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe('createTenant database ownership', () => {
  let tmpRoot: string;
  beforeEach(async () => { tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-db-own-')); });
  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    vi.resetModules();
    for (const m of ['child_process', '../config', '../config/loader', '../adapters/database', '../services/app',
      '../services/envVars', '../services/tenantAppDef', '../services/docker']) vi.doUnmock(m);
  });

  async function load(db: any, composeUpFails: boolean) {
    const appsDir = path.join(tmpRoot, 'apps');
    const execFile: any = vi.fn((_c: string, args: string[], cb: any) => {
      if (composeUpFails && args.includes('up')) cb(new Error('compose up failed'), '', '');
      else cb(null, '', '');
    });
    execFile[util.promisify.custom] = (c: string, args: string[]) =>
      new Promise((res, rej) => execFile(c, args, (e: any, stdout: string, stderr: string) => e ? rej(e) : res({ stdout, stderr })));
    vi.doMock('child_process', () => ({ execFile }));
    vi.doMock('../services/fileLock', () => ({ withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn(), withTenantLock: <T>(_a: string, _t: string, fn: () => Promise<T>) => fn() }));
    vi.doMock('../config', () => ({
      loadConfig: () => ({
        project: { name: 'T', prefix: 'test', db_prefix: 'test' },
        networking: { external_network: 'n', internal_network_template: '${prefix}-${tenantId}-internal', apps_path: '/a' },
        traefik: { log_level: 'INFO', tls_termination: 'upstream', upstream_entrypoint: 'web' },
      }),
      getAppsDir: () => appsDir,
      resolveAppDbPrefix: () => 'test',
    }));
    vi.doMock('../config/loader', () => ({ resolveCertResolver: () => ({ name: 'web', resolver: null }) }));
    vi.doMock('../adapters/database', () => ({ getDatabaseAdapter: () => db }));
    vi.doMock('../services/app', () => ({
      getApp: vi.fn(async () => ({
        id: 'demo', name: 'Demo', domain_template: '*.example.test',
        registry: { type: 'ghcr', url: 'ghcr.io', repository: 'a/demo', auth: { type: 'token' } },
        services: [{ name: 'web', image_suffix: 'web', required: true, ports: { internal: 3000 } }],
        default_image_tag: 'latest',
      })),
      applyApp: vi.fn(),
    }));
    vi.doMock('../services/envVars', () => ({ generateSharedEnvFile: vi.fn(async () => undefined) }));
    vi.doMock('../services/tenantAppDef', () => ({ writeTenantAppDef: vi.fn(async () => undefined) }));
    const mod = await import('../services/tenant');
    const errors = await import('../utils/httpErrors');
    return { createTenant: mod.createTenant, getTenantPath: mod.getTenantPath, ConflictError: errors.ConflictError };
  }

  const input = { appId: 'demo', tenantId: 'acme', domain: 'acme.example.test', imageTag: 'latest' };

  it('rejects with ConflictError and creates/drops nothing when the database already exists', async () => {
    const db = {
      initialize: vi.fn(async () => undefined),
      databaseExists: vi.fn(async () => true),
      createDatabase: vi.fn(),
      dropDatabase: vi.fn(async () => undefined),
    };
    const { createTenant, getTenantPath, ConflictError } = await load(db, false);
    await expect(createTenant(input)).rejects.toBeInstanceOf(ConflictError);
    expect(db.createDatabase).not.toHaveBeenCalled();
    expect(db.dropDatabase).not.toHaveBeenCalled();
    await expect(fs.access(getTenantPath('demo', 'acme'))).rejects.toThrow();
  });

  it('drops the database after a compose failure when this call created it', async () => {
    const db = {
      initialize: vi.fn(async () => undefined),
      databaseExists: vi.fn(async () => false),
      createDatabase: vi.fn(async () => ({ created: true, userCreated: true })),
      dropDatabase: vi.fn(async () => undefined),
    };
    const { createTenant } = await load(db, true);
    await expect(createTenant(input)).rejects.toThrow(/Failed to create tenant/);
    expect(db.dropDatabase).toHaveBeenCalledWith('demo_acme', { keepUser: false });
  });

  it('does not drop a database this call did not create, and keeps an adopted user', async () => {
    const db = {
      initialize: vi.fn(async () => undefined),
      databaseExists: vi.fn(async () => false),
      createDatabase: vi.fn(async () => ({ created: false, userCreated: false })),
      dropDatabase: vi.fn(async () => undefined),
    };
    const { createTenant } = await load(db, true);
    await expect(createTenant(input)).rejects.toThrow(/Failed to create tenant/);
    expect(db.dropDatabase).not.toHaveBeenCalled();
  });

  it('keeps a pre-existing user when rolling back a database it created', async () => {
    const db = {
      initialize: vi.fn(async () => undefined),
      databaseExists: vi.fn(async () => false),
      createDatabase: vi.fn(async () => ({ created: true, userCreated: false })),
      dropDatabase: vi.fn(async () => undefined),
    };
    const { createTenant } = await load(db, true);
    await expect(createTenant(input)).rejects.toThrow(/Failed to create tenant/);
    expect(db.dropDatabase).toHaveBeenCalledWith('demo_acme', { keepUser: true });
  });
});
