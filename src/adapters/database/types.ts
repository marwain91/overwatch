import { DatabaseConfig } from '../../config';

/**
 * Interface for database adapters.
 * Each adapter handles database operations for a specific database engine.
 */
export interface DatabaseAdapter {
  /**
   * Initialize the database connection pool
   */
  initialize(): Promise<void>;

  /**
   * Close the database connection pool
   */
  close(): Promise<void>;

  /**
   * Test the database connection
   */
  testConnection(): Promise<boolean>;

  /**
   * Create a new database and user for a tenant
   */
  createDatabase(tenantId: string, password: string): Promise<void>;

  /**
   * Drop the database and user for a tenant
   */
  dropDatabase(tenantId: string): Promise<void>;

  /**
   * List all tenant databases
   */
  listDatabases(): Promise<string[]>;

  /**
   * Dump the database to a file (for backups)
   */
  dumpDatabase(tenantId: string, outputPath: string): Promise<void>;

  /**
   * Restore the database from a file
   */
  restoreDatabase(tenantId: string, inputPath: string): Promise<void>;

  /**
   * Get the database name for a tenant
   */
  getDatabaseName(tenantId: string): string;

  /**
   * Get the database user name for a tenant
   */
  getUserName(tenantId: string): string;

  /**
   * Get the container name for Docker exec commands
   */
  getContainerName(): string;
}

/**
 * Configuration passed to database adapters
 */
export interface DatabaseAdapterConfig {
  type: 'mysql' | 'mariadb' | 'postgres';
  host: string;
  port: number;
  rootUser: string;
  rootPassword: string;
  containerName: string;
  dbPrefix: string;
}

/**
 * Convert Overwatch config to adapter config
 */
export function toAdapterConfig(config: DatabaseConfig, dbPrefix: string): DatabaseAdapterConfig {
  return {
    type: config.type,
    host: config.host,
    port: config.port,
    rootUser: config.root_user,
    rootPassword: process.env[config.root_password_env] || '',
    containerName: config.container_name,
    dbPrefix,
  };
}
