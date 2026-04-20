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
  const tenantId = 'finalio_daktela'; // callers pass appId_tenantId

  it('MySQL: project prefix "kwoutr" (no app override) → kwoutr_finalio_daktela', () => {
    const a = new MySQLAdapter(makeConfig('kwoutr'));
    expect(a.getDatabaseName(tenantId)).toBe('kwoutr_finalio_daktela');
    expect(a.getUserName(tenantId)).toBe('kwoutr_finalio_daktela');
  });

  it('MySQL: empty prefix "" (app override) → finalio_daktela', () => {
    const a = new MySQLAdapter(makeConfig(''));
    expect(a.getDatabaseName(tenantId)).toBe('finalio_daktela');
    expect(a.getUserName(tenantId)).toBe('finalio_daktela');
  });

  it('MySQL: custom prefix "custom" (app override) → custom_finalio_daktela', () => {
    const a = new MySQLAdapter(makeConfig('custom'));
    expect(a.getDatabaseName(tenantId)).toBe('custom_finalio_daktela');
    expect(a.getUserName(tenantId)).toBe('custom_finalio_daktela');
  });

  it('Postgres: empty prefix → finalio_daktela', () => {
    const a = new PostgresAdapter(makeConfig('', 'postgres'));
    expect(a.getDatabaseName(tenantId)).toBe('finalio_daktela');
  });

  it('Postgres: non-empty prefix → custom_finalio_daktela', () => {
    const a = new PostgresAdapter(makeConfig('custom', 'postgres'));
    expect(a.getDatabaseName(tenantId)).toBe('custom_finalio_daktela');
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
