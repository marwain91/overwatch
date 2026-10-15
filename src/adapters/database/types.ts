import { DatabaseConfig } from '../../config';

// Database management types

export interface DatabaseServerInfo {
  type: 'mysql' | 'mariadb' | 'postgres';
  version: string;
  uptime: number;
  host: string;
  port: number;
}

export interface DatabaseServerStats {
  connections: { active: number; max: number; total: number };
  queries: { total: number; perSecond: number };
  threads: { running: number; cached: number; connected: number };
  memory: { bufferPoolSize: number; bufferPoolUsed: number };
}

export interface DatabaseDetail {
  name: string;
  sizeBytes: number;
  tableCount: number;
  isTenantDb: boolean;
}

export interface DatabaseProcess {
  id: number;
  user: string;
  database: string | null;
  host: string;
  command: string;
  time: number;
  state: string;
  query: string | null;
}

export interface CreateDatabaseResult {
  /** True only when this call created the database */
  created: boolean;
  /** True only when this call created the database user */
  userCreated: boolean;
}

/**
 * resetDatabase failed before it changed anything (a precondition failed, or
 * the drop was refused): the database is exactly as it was.
 */
export class DatabaseResetRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseResetRefusedError';
  }
}

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
   * Create a database and user for a tenant. Reports what this call created so
   * callers only ever roll back their own objects; a failure part-way drops
   * only what this call created before rethrowing.
   */
  createDatabase(tenantId: string, password: string): Promise<CreateDatabaseResult>;

  /**
   * Whether the tenant's database already exists
   */
  databaseExists(tenantId: string): Promise<boolean>;

  /**
   * Drop the database and user for a tenant. `keepUser` leaves the user alone
   * (rollback of a call that adopted a pre-existing user).
   */
  dropDatabase(tenantId: string, options?: { keepUser?: boolean }): Promise<void>;

  /**
   * Drop the tenant's database and create it again, empty. The tenant user and
   * its access to the database stay as they are, and so do the database's
   * character set/collation (MySQL) or encoding/locale (Postgres). A missing
   * database is created. Callers stop whatever writes to it first; remaining
   * sessions on the database are ended. Throws DatabaseResetRefusedError when
   * it failed before changing anything.
   */
  resetDatabase(tenantId: string): Promise<void>;

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

  /**
   * Get server info (type, version, uptime)
   */
  getServerInfo(): Promise<DatabaseServerInfo>;

  /**
   * Get server statistics (connections, queries, threads, memory)
   */
  getServerStats(): Promise<DatabaseServerStats>;

  /**
   * List all databases with size and table count details
   */
  getDatabasesWithDetails(): Promise<DatabaseDetail[]>;

  /**
   * Get active processes/queries
   */
  getProcessList(): Promise<DatabaseProcess[]>;

  /**
   * Kill a running process by ID
   */
  killProcess(id: number): Promise<void>;
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
