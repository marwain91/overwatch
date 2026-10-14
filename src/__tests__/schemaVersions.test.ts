import { describe, it, expect } from 'vitest';

describe('R2 schemaVersions — refuses data newer than code', () => {
  it('findPendingMigrations throws on newer-than-code version', async () => {
    const { findPendingMigrations, CURRENT_SCHEMA_VERSIONS } = await import('../services/schemaVersions');
    expect(() => findPendingMigrations({ apps: CURRENT_SCHEMA_VERSIONS.apps + 1 }))
      .toThrow(/newer than code/);
  });

  it('returns empty when stored versions match current', async () => {
    const { findPendingMigrations, CURRENT_SCHEMA_VERSIONS } = await import('../services/schemaVersions');
    expect(findPendingMigrations(CURRENT_SCHEMA_VERSIONS)).toEqual([]);
  });

  it('returns pending list when stored version is older', async () => {
    const { findPendingMigrations, CURRENT_SCHEMA_VERSIONS } = await import('../services/schemaVersions');
    const pending = findPendingMigrations({ apps: 1, envVars: CURRENT_SCHEMA_VERSIONS.envVars });
    expect(pending).toEqual([{ store: 'apps', from: 1, to: CURRENT_SCHEMA_VERSIONS.apps }]);
  });
});


