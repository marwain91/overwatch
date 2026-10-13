import { describe, it, expect, vi, afterEach } from 'vitest';
import { MySQLAdapter } from '../adapters/database/mysql';
import { PostgresAdapter } from '../adapters/database/postgres';
import { DatabaseAdapterConfig } from '../adapters/database/types';

function makeConfig(dbPrefix: string, type: 'mariadb' | 'postgres'): DatabaseAdapterConfig {
  return {
    type,
    host: 'db',
    port: type === 'postgres' ? 5432 : 3306,
    rootUser: 'root',
    rootPassword: 'pw',
    containerName: 'db',
    dbPrefix,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('listDatabases — `_` in the prefix is a LIKE wildcard', () => {
  it('MySQL keeps only names that really start with the prefix', async () => {
    const adapter = new MySQLAdapter(makeConfig('a_b', 'mariadb'));
    (adapter as any).pool = {
      query: vi.fn(async () => [[{ Database: 'a_b_t1' }, { Database: 'aXb_t2' }]]),
    };
    await expect(adapter.listDatabases()).resolves.toEqual(['a_b_t1']);
  });

  it('Postgres keeps only names that really start with the prefix', async () => {
    const adapter = new PostgresAdapter(makeConfig('a_b', 'postgres'));
    (adapter as any).pool = {
      query: vi.fn(async () => ({ rows: [{ datname: 'a_b_t1' }, { datname: 'aXb_t2' }] })),
    };
    await expect(adapter.listDatabases()).resolves.toEqual(['a_b_t1']);
  });

  it('returns everything when no prefix is configured', async () => {
    const adapter = new MySQLAdapter(makeConfig('', 'mariadb'));
    (adapter as any).pool = { query: vi.fn(async () => [[{ Database: 'x' }, { Database: 'y' }]]) };
    await expect(adapter.listDatabases()).resolves.toEqual(['x', 'y']);
  });
});

describe('Postgres pool', () => {
  it('survives an idle-client error instead of crashing the process', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pool = (new PostgresAdapter(makeConfig('p', 'postgres')) as any).createPool();
    try {
      expect(() => pool.emit('error', new Error('terminating connection due to administrator command'))).not.toThrow();
      expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/idle client error/));
    } finally {
      await pool.end();
    }
  });
});
