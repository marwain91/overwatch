import { describe, it, expect } from 'vitest';

import { MySQLAdapter } from '../adapters/database/mysql';
import { PostgresAdapter } from '../adapters/database/postgres';
import { DatabaseAdapterConfig } from '../adapters/database/types';
import { resolveAppDbPrefix, getDatabasePrefix } from '../config/loader';

function makeConfig(dbPrefix: string, type: 'mariadb' | 'postgres' = 'mariadb'): DatabaseAdapterConfig {
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

describe('Adapter getDatabaseName / getUserName — per-app prefix', () => {
  const tenantId = 'gadgets_daktela'; // callers pass appId_tenantId

  it('MySQL: project prefix "acme" (no app override) → acme_gadgets_daktela', () => {
    const a = new MySQLAdapter(makeConfig('acme'));
    expect(a.getDatabaseName(tenantId)).toBe('acme_gadgets_daktela');
    expect(a.getUserName(tenantId)).toBe('acme_gadgets_daktela');
  });

  it('MySQL: empty prefix "" (app override) → gadgets_daktela', () => {
    const a = new MySQLAdapter(makeConfig(''));
    expect(a.getDatabaseName(tenantId)).toBe('gadgets_daktela');
    expect(a.getUserName(tenantId)).toBe('gadgets_daktela');
  });

  it('MySQL: custom prefix "custom" (app override) → custom_gadgets_daktela', () => {
    const a = new MySQLAdapter(makeConfig('custom'));
    expect(a.getDatabaseName(tenantId)).toBe('custom_gadgets_daktela');
    expect(a.getUserName(tenantId)).toBe('custom_gadgets_daktela');
  });

  it('Postgres: empty prefix → gadgets_daktela', () => {
    const a = new PostgresAdapter(makeConfig('', 'postgres'));
    expect(a.getDatabaseName(tenantId)).toBe('gadgets_daktela');
  });

  it('Postgres: non-empty prefix → custom_gadgets_daktela', () => {
    const a = new PostgresAdapter(makeConfig('custom', 'postgres'));
    expect(a.getDatabaseName(tenantId)).toBe('custom_gadgets_daktela');
  });
});

describe('resolveAppDbPrefix — effective prefix resolution', () => {
  const projectPrefix = getDatabasePrefix();

  it('no app → project prefix (inherits from overwatch.yaml)', () => {
    expect(resolveAppDbPrefix()).toBe(projectPrefix);
  });

  it('app with undefined db_prefix → project prefix', () => {
    expect(resolveAppDbPrefix({ db_prefix: undefined } as any)).toBe(projectPrefix);
  });

  it('app with empty-string db_prefix → empty string (explicit override)', () => {
    expect(resolveAppDbPrefix({ db_prefix: '' } as any)).toBe('');
  });

  it('app with custom db_prefix → that value', () => {
    expect(resolveAppDbPrefix({ db_prefix: 'custom' } as any)).toBe('custom');
  });
});
