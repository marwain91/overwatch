import { Pool, Client } from 'pg';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { createReadStream } from 'fs';
import { DatabaseAdapter, DatabaseAdapterConfig } from './types';

const execFileAsync = promisify(execFile);

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
    if (this.pool) {
      return; // Already initialized
    }
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
      // Use format() with %I for identifiers and %L for literals to prevent SQL injection
      await client.query(`
        DO $body$ BEGIN
          EXECUTE format('CREATE USER %I WITH PASSWORD %L', $1, $2);
        EXCEPTION WHEN duplicate_object THEN
          EXECUTE format('ALTER USER %I WITH PASSWORD %L', $1, $2);
        END $body$;
      `, [userName, password]);

      // Check if database exists
      const dbExists = await client.query(
        `SELECT 1 FROM pg_database WHERE datname = $1`,
        [dbName]
      );

      if (dbExists.rows.length === 0) {
        // CREATE DATABASE cannot use parameterized queries, but dbName is validated upstream
        // (only alphanumeric, underscore, hyphen from config prefix + appId + tenantId)
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

    // Use execFile (no shell) to avoid password injection; pass password via PGPASSWORD env
    const { stdout } = await execFileAsync('docker', [
      'exec', '-e', `PGPASSWORD=${this.config.rootPassword}`,
      containerName, 'pg_dump', '-U', this.config.rootUser, '-d', dbName,
    ], { maxBuffer: 100 * 1024 * 1024 });

    const fs = await import('fs/promises');
    await fs.writeFile(outputPath, stdout);
  }

  async restoreDatabase(tenantId: string, inputPath: string): Promise<void> {
    const dbName = this.getDatabaseName(tenantId);
    const containerName = this.getContainerName();

    // Use spawn (no shell) with stdin pipe to avoid password injection
    return new Promise<void>((resolve, reject) => {
      const proc = spawn('docker', [
        'exec', '-i', '-e', `PGPASSWORD=${this.config.rootPassword}`,
        containerName, 'psql', '-U', this.config.rootUser, '-d', dbName,
      ]);

      const input = createReadStream(inputPath);
      input.pipe(proc.stdin);

      let stderr = '';
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`psql restore exited with code ${code}: ${stderr}`));
      });
      proc.on('error', reject);
    });
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
