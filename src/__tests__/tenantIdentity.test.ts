import { describe, it, expect } from 'vitest';
import {
  tenantIdentity,
  containerName,
  isTenantOwnedVolume,
  findIdentityConflict,
  assertTenantDbName,
  type TenantNames,
} from '../services/tenantIdentity';
import { ValidationError } from '../utils/httpErrors';

const names = (appId: string, tenantId: string, extra: Partial<TenantNames> = {}): TenantNames => {
  const id = tenantIdentity(appId, tenantId);
  return { appId, tenantId, composeProject: id.composeProject, namePrefix: id.namePrefix, dbName: `test_${id.dbId}`, ...extra };
};

describe('tenantIdentity', () => {
  it('derives the compose project, name prefix and DB id, mapping "-" to "_" only for the DB id', () => {
    expect(tenantIdentity('shop', 'eu-api')).toEqual({
      appId: 'shop',
      tenantId: 'eu-api',
      composeProject: 'shop-eu-api',
      namePrefix: 'shop-eu-api-',
      dbId: 'shop_eu_api',
    });
    expect(tenantIdentity('my-app', 'acme').dbId).toBe('my_app_acme');
  });

  it('keeps the names existing tenants already use', () => {
    expect(tenantIdentity('shop', 't1').composeProject).toBe('shop-t1');
    expect(tenantIdentity('shop', 't1').dbId).toBe('shop_t1');
    expect(containerName('shop', 't1', 'backend')).toBe('shop-t1-backend');
  });

  it('treats only volumes under the tenant name prefix as owned by the tenant', () => {
    expect(isTenantOwnedVolume('shop-t1-uploads', 'shop', 't1')).toBe(true);
    expect(isTenantOwnedVolume('backend-uploads', 'shop', 't1')).toBe(false);
    expect(isTenantOwnedVolume('t1-uploads', 'shop', 't1')).toBe(false);
    expect(isTenantOwnedVolume('shop-t1', 'shop', 't1')).toBe(false);
  });
});

describe('findIdentityConflict', () => {
  it('reports two tenants whose hyphenated ids derive the same compose project and database', () => {
    const conflict = findIdentityConflict(names('shop', 'eu-api'), [names('shop-eu', 'api')]);
    expect(conflict).toMatch(/compose project 'shop-eu-api'/);
    expect(conflict).toMatch(/tenant 'api' of app 'shop-eu'/);
  });

  it('compares against the names an existing tenant actually uses', () => {
    const existing = names('other', 'x', { composeProject: 'legacy-project', dbName: 'test_shop_acme' });
    expect(findIdentityConflict(names('shop', 'acme'), [existing])).toMatch(/database 'test_shop_acme'/);
    const project = names('other', 'y', { composeProject: 'shop-acme' });
    expect(findIdentityConflict(names('shop', 'acme'), [project])).toMatch(/compose project 'shop-acme'/);
  });

  it('reports a clash of concrete container or owned volume names', () => {
    const candidate = names('shop', 'eu', { containerNames: ['shop-eu-api-web'], volumeNames: ['shop-eu-api-data'] });
    const byContainer = names('shop', 'eu-api', { containerNames: ['shop-eu-api-web'] });
    expect(findIdentityConflict(candidate, [byContainer])).toMatch(/container 'shop-eu-api-web'/);
    const byVolume = names('shop', 'eu-api', { volumeNames: ['shop-eu-api-data'] });
    expect(findIdentityConflict(candidate, [byVolume])).toMatch(/volume 'shop-eu-api-data'/);
  });

  it('allows tenants that only share a name prefix, and ignores the tenant itself', () => {
    expect(findIdentityConflict(names('shop', 'acme'), [names('shop', 'acme-staging')])).toBeNull();
    expect(findIdentityConflict(names('shop', 'acme'), [names('shop', 'acme')])).toBeNull();
  });
});

describe('assertTenantDbName', () => {
  it('applies the MySQL 32-character user-name limit', () => {
    expect(() => assertTenantDbName('a'.repeat(32), 'mysql')).not.toThrow();
    expect(() => assertTenantDbName('a'.repeat(33), 'mysql')).toThrow(ValidationError);
    expect(() => assertTenantDbName('a'.repeat(33), 'mysql')).toThrow(/at most 32/);
  });

  it('applies the engine identifier limits for MariaDB and Postgres', () => {
    expect(() => assertTenantDbName('a'.repeat(64), 'mariadb')).not.toThrow();
    expect(() => assertTenantDbName('a'.repeat(65), 'mariadb')).toThrow(/at most 64/);
    expect(() => assertTenantDbName('a'.repeat(63), 'postgres')).not.toThrow();
    expect(() => assertTenantDbName('a'.repeat(64), 'postgres')).toThrow(/at most 63/);
  });

  it('rejects characters the database adapters refuse', () => {
    expect(() => assertTenantDbName('my-prefix_shop_t1', 'mariadb')).toThrow(/lowercase letters, digits and "_"/);
  });
});
