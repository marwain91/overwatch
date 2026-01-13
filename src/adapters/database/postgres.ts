import { Pool, Client } from 'pg';
import { exec } from 'child_process';
import { promisify } from 'util';
import { DatabaseAdapter, DatabaseAdapterConfig } from './types';

const execAsync = promisify(exec);

/**
 * PostgreSQL database adapter
 */
export class PostgresAdapter implements DatabaseAdapter {
  private pool: Pool | null = null;
  private config: DatabaseAdapterConfig;

  constructor(config: DatabaseAdapterConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    this.pool = new Pool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.rootUser,
      password: this.config.rootPassword,
      database: 'postgres', // Connect to default db for admin operations
      max: 5,
    });
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
      await this.pool!.query('SELECT 1');
      return true;
    } catch (error) {
      console.error('PostgreSQL connection failed:', error);
      return false;
    }
  }

  async createDatabase(tenantId: string, password: string): Promise<void> {
    if (!this.pool) {
      await this.initialize();
    }

    const dbName = this.getDatabaseName(tenantId);
    const userName = this.getUserName(tenantId);
    const client = await this.pool!.connect();

    try {
      // Create user if not exists (PostgreSQL doesn't have IF NOT EXISTS for CREATE USER)
      // Use PL/pgSQL DO block to handle this
      await client.query(`
        DO $$ BEGIN
          CREATE USER "${userName}" WITH PASSWORD '${password.replace(/'/g, "''")}';
        EXCEPTION WHEN duplicate_object THEN
          ALTER USER "${userName}" WITH PASSWORD '${password.replace(/'/g, "''")}';
        END $$;
      `);

      // Check if database exists
      const dbExists = await client.query(
        `SELECT 1 FROM pg_database WHERE datname = $1`,
        [dbName]
      );

      if (dbExists.rows.length === 0) {
        // Need to use a separate connection without transaction for CREATE DATABASE
        await client.query(`CREATE DATABASE "${dbName}" OWNER "${userName}"`);
      }

      // Grant privileges
      await client.query(`GRANT ALL PRIVILEGES ON DATABASE "${dbName}" TO "${userName}"`);
    } finally {
      client.release();
    }
  }

  async dropDatabase(tenantId: string): Promise<void> {
    if (!this.pool) {
      await this.initialize();
    }

    const dbName = this.getDatabaseName(tenantId);
    const userName = this.getUserName(tenantId);
    const client = await this.pool!.connect();

    try {
      // Terminate connections to the database
      await client.query(`
        SELECT pg_terminate_backend(pg_stat_activity.pid)
        FROM pg_stat_activity
        WHERE pg_stat_activity.datname = $1
        AND pid <> pg_backend_pid()
      `, [dbName]);

      // Drop database
      await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);

      // Drop user
      await client.query(`DROP USER IF EXISTS "${userName}"`);
    } finally {
      client.release();
    }
  }

  async listDatabases(): Promise<string[]> {
    if (!this.pool) {
      await this.initialize();
    }

    const pattern = `${this.config.dbPrefix}_%`;
    const result = await this.pool!.query(
      `SELECT datname FROM pg_database WHERE datname LIKE $1`,
      [pattern]
    );
    return result.rows.map(row => row.datname);
  }

  async dumpDatabase(tenantId: string, outputPath: string): Promise<void> {
    const dbName = this.getDatabaseName(tenantId);
    const containerName = this.getContainerName();

    // Set PGPASSWORD environment variable for pg_dump
    const cmd = `docker exec -e PGPASSWORD="${this.config.rootPassword}" ${containerName} pg_dump -U ${this.config.rootUser} -d "${dbName}" > "${outputPath}"`;

    await execAsync(cmd, { maxBuffer: 100 * 1024 * 1024 });
  }

  async restoreDatabase(tenantId: string, inputPath: string): Promise<void> {
    const dbName = this.getDatabaseName(tenantId);
    const containerName = this.getContainerName();

    // Set PGPASSWORD environment variable for psql
    const cmd = `docker exec -i -e PGPASSWORD="${this.config.rootPassword}" ${containerName} psql -U ${this.config.rootUser} -d "${dbName}" < "${inputPath}"`;

    await execAsync(cmd, { maxBuffer: 100 * 1024 * 1024 });
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
}
