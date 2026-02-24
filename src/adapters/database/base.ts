import { DatabaseAdapter, DatabaseAdapterConfig } from './types';
import { assertSafeIdentifier } from '../../utils/security';

/**
 * Abstract base class for database adapters.
 * Provides shared implementations for common operations.
 */
export abstract class BaseDatabaseAdapter implements DatabaseAdapter {
  protected pool: any = null;
  protected config: DatabaseAdapterConfig;

  constructor(config: DatabaseAdapterConfig) {
    this.config = config;
  }

  /** Maximum identifier length for this database engine */
  protected abstract get maxIdentifierLength(): number;

  /** Engine-specific pool creation */
  protected abstract createPool(): any;

  /** Engine-specific test query */
  protected abstract executeTestQuery(): Promise<void>;

  async initialize(): Promise<void> {
    if (this.pool) {
      return; // Already initialized
    }
    this.pool = this.createPool();
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      if (!this.pool) {
        await this.initialize();
      }
      await this.executeTestQuery();
      return true;
    } catch (error) {
      console.error(`${this.config.type} connection failed:`, error);
      return false;
    }
  }

  /** Validate both database and user identifiers */
  protected validateIdentifiers(dbName: string, userName: string): void {
    assertSafeIdentifier(dbName, this.maxIdentifierLength);
    assertSafeIdentifier(userName, this.maxIdentifierLength);
  }

  getDatabaseName(tenantId: string): string {
    return `${this.config.dbPrefix}_${tenantId}`;
  }

  getUserName(tenantId: string): string {
    return `${this.config.dbPrefix}_${tenantId}`;
  }

  getContainerName(): string {
    return this.config.containerName;
  }

  abstract createDatabase(tenantId: string, password: string): Promise<void>;
  abstract dropDatabase(tenantId: string): Promise<void>;
  abstract listDatabases(): Promise<string[]>;
  abstract dumpDatabase(tenantId: string, outputPath: string): Promise<void>;
  abstract restoreDatabase(tenantId: string, inputPath: string): Promise<void>;
}
