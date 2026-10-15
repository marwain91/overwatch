import { describe, it, expect, vi } from 'vitest';

vi.mock('pg', () => ({ Pool: class { on() {} end = vi.fn(async () => {}); } }));
vi.mock('mysql2/promise', () => ({ default: { createPool: vi.fn(() => ({ end: vi.fn(async () => {}) })) } }));

import { MySQLAdapter } from '../adapters/database/mysql';
import { PostgresAdapter } from '../adapters/database/postgres';
import { DatabaseResetRefusedError, type DatabaseAdapterConfig } from '../adapters/database/types';

function cfg(type: 'mariadb' | 'postgres'): DatabaseAdapterConfig {
  return { type, host: 'db', port: 1, rootUser: 'root', rootPassword: 'x', containerName: 'dbc', dbPrefix: 'p' };
}

/** Fake connection; `rows(sql)` decides the result rows of each statement. */
function fakeConn(rows: (sql: string) => any[] = () => [], failOn?: string) {
  const queries: string[] = [];
  const params: unknown[][] = [];
  const query = vi.fn(async (sql: string, p?: unknown[]) => {
    queries.push(sql.trim());
    params.push(p ?? []);
    if (failOn && sql.includes(failOn)) throw new Error('boom');
    return rows(sql);
  });
  return { queries, params, query, release: vi.fn() };
}

describe('mysql resetDatabase', () => {
  function make(conn: ReturnType<typeof fakeConn>) {
    const a = new MySQLAdapter(cfg('mariadb'));
    const mysqlConn = { ...conn, query: async (sql: string, p?: unknown[]) => [await conn.query(sql, p), undefined] };
    (a as any).pool = { getConnection: vi.fn(async () => mysqlConn), query: mysqlConn.query };
    return a;
  }

  it('drops and recreates the database with its own character set and collation', async () => {
    const conn = fakeConn(sql => (sql.includes('information_schema.SCHEMATA') ? [{ cs: 'latin1', co: 'latin1_swedish_ci' }] : []));
    await make(conn).resetDatabase('t1');
    const drop = conn.queries.indexOf('DROP DATABASE IF EXISTS `p_t1`');
    const create = conn.queries.indexOf('CREATE DATABASE `p_t1` CHARACTER SET latin1 COLLATE latin1_swedish_ci');
    expect(drop).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(drop);
    expect(conn.params[conn.queries.findIndex(q => q.includes('SCHEMATA'))]).toEqual(['p_t1']);
  });

  // Database-level grants live in mysql.db and survive DROP DATABASE.
  it('keeps the user and its grants', async () => {
    const conn = fakeConn(() => []);
    await make(conn).resetDatabase('t1');
    expect(conn.queries.some(q => /^(DROP USER|REVOKE|GRANT|CREATE USER)/.test(q))).toBe(false);
    expect(conn.release).toHaveBeenCalled();
  });

  it('creates a missing database with the defaults createDatabase uses', async () => {
    const conn = fakeConn(() => []);
    await make(conn).resetDatabase('t1');
    expect(conn.queries).toContain('CREATE DATABASE `p_t1` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
  });

  it('refuses unsafe identifiers before touching anything', async () => {
    const conn = fakeConn();
    await expect(make(conn).resetDatabase('T1;drop')).rejects.toThrow(/Unsafe/);
    expect(conn.queries).toEqual([]);
  });

  // DROP waits on metadata locks with no limit: a forgotten session must not hang a restore.
  it('ends other sessions on the database and bounds the lock wait, then restores the default', async () => {
    const conn = fakeConn(sql => (sql.includes('PROCESSLIST') ? [{ id: 41 }, { id: 42 }] : []));
    await make(conn).resetDatabase('t1');
    const q = conn.queries;
    expect(conn.params[q.findIndex(x => x.includes('PROCESSLIST'))]).toEqual(['p_t1']);
    expect(conn.params.filter((_p, i) => q[i] === 'KILL ?')).toEqual([[41], [42]]);
    const drop = q.indexOf('DROP DATABASE IF EXISTS `p_t1`');
    expect(q.indexOf('SET SESSION lock_wait_timeout = 60')).toBeLessThan(drop);
    expect(q.lastIndexOf('KILL ?')).toBeLessThan(drop);
    expect(q[q.length - 1]).toBe('SET SESSION lock_wait_timeout = DEFAULT');
  });

  it('reports a failure before the DROP as "nothing changed", and one after it as a plain error', async () => {
    await expect(make(fakeConn(() => [], 'information_schema.SCHEMATA')).resetDatabase('t1')).rejects.toBeInstanceOf(DatabaseResetRefusedError);
    const after = make(fakeConn(() => [], 'CREATE DATABASE')).resetDatabase('t1');
    await expect(after).rejects.toThrow('boom');
    await expect(after).rejects.not.toBeInstanceOf(DatabaseResetRefusedError);
  });
});

describe('postgres resetDatabase', () => {
  const tpl = { enc: 'UTF8', datcollate: 'en_US.utf8', datctype: 'en_US.utf8' };

  function make(conn: ReturnType<typeof fakeConn>) {
    const a = new PostgresAdapter(cfg('postgres'));
    const pgConn = { ...conn, query: async (sql: string, p?: unknown[]) => ({ rows: await conn.query(sql, p) }) };
    (a as any).pool = { connect: vi.fn(async () => pgConn), query: pgConn.query };
    return a;
  }

  /** The database row for `p_t1` (null: absent) and template1; the tenant role exists unless `noRole`. */
  const catalog = (db: typeof tpl | null, noRole = false) => (sql: string) => {
    if (sql.includes('FROM pg_roles')) return noRole ? [] : [{ x: 1 }];
    if (!sql.includes('FROM pg_database')) return [];
    return [...(db ? [{ datname: 'p_t1', ...db }] : []), { datname: 'template1', ...tpl }];
  };

  // The recreated database is owned by the tenant role: without it the CREATE
  // would fail after the DROP and leave the tenant with no database at all.
  it('refuses before dropping anything when the tenant role does not exist', async () => {
    const conn = fakeConn(catalog(tpl, true));
    await expect(make(conn).resetDatabase('t1')).rejects.toBeInstanceOf(DatabaseResetRefusedError);
    expect(conn.queries.some(q => q.startsWith('DROP') || q.includes('pg_terminate_backend'))).toBe(false);
  });

  // DROP DATABASE either drops or leaves the database intact (e.g. a session reconnected).
  it('reports a refused DROP as "nothing changed", and a failed CREATE after it as a plain error', async () => {
    await expect(make(fakeConn(catalog(tpl), 'DROP DATABASE')).resetDatabase('t1')).rejects.toBeInstanceOf(DatabaseResetRefusedError);
    const after = make(fakeConn(catalog(tpl), 'CREATE DATABASE')).resetDatabase('t1');
    await expect(after).rejects.toThrow('boom');
    await expect(after).rejects.not.toBeInstanceOf(DatabaseResetRefusedError);
  });

  it('terminates connections, drops and recreates the database owned by the tenant role', async () => {
    const conn = fakeConn(catalog(tpl));
    await make(conn).resetDatabase('t1');
    const q = conn.queries;
    const terminate = q.findIndex(s => s.includes('pg_terminate_backend'));
    const drop = q.indexOf('DROP DATABASE IF EXISTS "p_t1"');
    const create = q.indexOf('CREATE DATABASE "p_t1" OWNER "p_t1"');
    expect(terminate).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(terminate);
    expect(create).toBeGreaterThan(drop);
    // Same access as createDatabase gives: only the tenant role may connect.
    expect(q).toContain('REVOKE CONNECT ON DATABASE "p_t1" FROM PUBLIC');
    expect(q).toContain('GRANT CONNECT ON DATABASE "p_t1" TO "p_t1"');
    expect(q.some(s => s.startsWith('DROP USER') || s.startsWith('CREATE USER'))).toBe(false);
  });

  it('keeps an encoding/locale that differs from template1', async () => {
    const conn = fakeConn(catalog({ enc: 'LATIN1', datcollate: 'C', datctype: 'C' }));
    await make(conn).resetDatabase('t1');
    expect(conn.queries).toContain(
      `CREATE DATABASE "p_t1" OWNER "p_t1" TEMPLATE template0 ENCODING 'LATIN1' LC_COLLATE 'C' LC_CTYPE 'C'`,
    );
  });

  it('creates a missing database', async () => {
    const conn = fakeConn(catalog(null));
    await make(conn).resetDatabase('t1');
    expect(conn.queries).toContain('CREATE DATABASE "p_t1" OWNER "p_t1"');
  });

  it('lifts statement_timeout for the drop and resets it before release', async () => {
    const conn = fakeConn(catalog(tpl));
    await make(conn).resetDatabase('t1');
    expect(conn.queries.indexOf('SET statement_timeout = 0')).toBeLessThan(conn.queries.findIndex(s => s.startsWith('DROP DATABASE')));
    expect(conn.queries[conn.queries.length - 1]).toBe('RESET statement_timeout');
    expect(conn.release).toHaveBeenCalled();
  });
});
