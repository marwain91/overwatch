import { loadConfig } from '../../config';
import { DatabaseAdapter, DatabaseAdapterConfig, toAdapterConfig } from './types';
import { MySQLAdapter } from './mysql';
import { PostgresAdapter } from './postgres';

export * from './types';
export { MySQLAdapter } from './mysql';
export { PostgresAdapter } from './postgres';

let cachedAdapter: DatabaseAdapter | null = null;

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
 * Get a singleton database adapter instance based on the Overwatch configuration
 */
export function getDatabaseAdapter(): DatabaseAdapter {
  if (!cachedAdapter) {
    cachedAdapter = createDatabaseAdapter();
  }
  return cachedAdapter;
}

/**
 * Clear the cached adapter (useful for testing or config changes)
 */
export function clearAdapterCache(): void {
  cachedAdapter = null;
}

/**
 * Convert Overwatch config to adapter config
 */
function getAdapterConfigFromOverwatch(): DatabaseAdapterConfig {
  const config = loadConfig();
  return toAdapterConfig(config.database, config.project.db_prefix);
}
