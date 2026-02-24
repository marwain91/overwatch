import { Pool } from 'pg';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { createReadStream } from 'fs';
import { DatabaseAdapterConfig } from './types';
import { BaseDatabaseAdapter } from './base';

const execFileAsync = promisify(execFile);

/**
 * PostgreSQL database adapter
 */
export class PostgresAdapter extends BaseDatabaseAdapter {
  protected declare pool: Pool | null;

  protected get maxIdentifierLength(): number {
    return 63;
  }

  protected createPool(): Pool {
    return new Pool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.rootUser,
      password: this.config.rootPassword,
      database: 'postgres', // Connect to default db for admin operations
      max: 5,
    });
  }

  protected async executeTestQuery(): Promise<void> {
    await this.pool!.query('SELECT 1');
  }

  async createDatabase(tenantId: string, password: string): Promise<void> {
    if (!this.pool) {
      await this.initialize();
    }

    const dbName = this.getDatabaseName(tenantId);
    const userName = this.getUserName(tenantId);

    this.validateIdentifiers(dbName, userName);

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
        // CREATE DATABASE cannot use parameterized queries; escape identifiers as defense-in-depth
        const safeDb = dbName.replace(/"/g, '""');
        const safeUser = userName.replace(/"/g, '""');
        await client.query(`CREATE DATABASE "${safeDb}" OWNER "${safeUser}"`);
      }

      // Grant privileges
      const safeDb = dbName.replace(/"/g, '""');
      const safeUser = userName.replace(/"/g, '""');
      await client.query(`GRANT ALL PRIVILEGES ON DATABASE "${safeDb}" TO "${safeUser}"`);
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

    this.validateIdentifiers(dbName, userName);

    const client = await this.pool!.connect();

    try {
      // Terminate connections to the database
      await client.query(`
        SELECT pg_terminate_backend(pg_stat_activity.pid)
        FROM pg_stat_activity
        WHERE pg_stat_activity.datname = $1
        AND pid <> pg_backend_pid()
      `, [dbName]);

      // Drop database (escape identifiers as defense-in-depth)
      const safeDb = dbName.replace(/"/g, '""');
      const safeUser = userName.replace(/"/g, '""');
      await client.query(`DROP DATABASE IF EXISTS "${safeDb}"`);

      // Drop user
      await client.query(`DROP USER IF EXISTS "${safeUser}"`);
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
}
