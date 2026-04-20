import { loadConfig, resolveAppDbPrefix } from '../../config';
import { DatabaseAdapter, DatabaseAdapterConfig, toAdapterConfig } from './types';
import { MySQLAdapter } from './mysql';
import { PostgresAdapter } from './postgres';
import type { AppDefinition } from '../../models/app';

export * from './types';
export { MySQLAdapter } from './mysql';
export { PostgresAdapter } from './postgres';

const adapterCache = new Map<string, DatabaseAdapter>();

/**
 * Create a database adapter based on the configuration
 */
export function createDatabaseAdapter(adapterConfig?: DatabaseAdapterConfig): DatabaseAdapter {
  const config = adapterConfig || getAdapterConfigFromOverwatch();

  switch (config.type) {
    case 'mysql':
    case 'mariadb':
      return new MySQLAdapter(config);
    case 'postgres':
      return new PostgresAdapter(config);
    default:
      throw new Error(`Unsupported database type: ${config.type}`);
  }
}

/**
 * Get a cached database adapter for the given app's effective db_prefix.
 * When no app is provided, returns an adapter scoped to the project-level prefix.
 * Adapters are cached per effective prefix so multi-app deployments don't share
 * a single incorrect prefix across apps.
 */
export function getDatabaseAdapter(app?: Pick<AppDefinition, 'db_prefix'>): DatabaseAdapter {
  const prefix = resolveAppDbPrefix(app);
  let adapter = adapterCache.get(prefix);
  if (!adapter) {
    const config = loadConfig();
    adapter = createDatabaseAdapter(toAdapterConfig(config.database, prefix));
    adapterCache.set(prefix, adapter);
  }
  return adapter;
}

/**
 * Clear all cached adapters (useful for testing or config changes)
 */
export function clearAdapterCache(): void {
  adapterCache.clear();
}

/**
 * Convert Overwatch config to adapter config
 */
function getAdapterConfigFromOverwatch(): DatabaseAdapterConfig {
  const config = loadConfig();
  return toAdapterConfig(config.database, config.project.db_prefix);
}
