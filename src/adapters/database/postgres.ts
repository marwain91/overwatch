import { Pool } from 'pg';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { createReadStream } from 'fs';
import { DatabaseAdapterConfig, DatabaseServerInfo, DatabaseServerStats, DatabaseDetail, DatabaseProcess } from './types';
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

  async getServerInfo(): Promise<DatabaseServerInfo> {
    if (!this.pool) await this.initialize();

    const versionResult = await this.pool!.query('SELECT version()');
    const uptimeResult = await this.pool!.query('SELECT pg_postmaster_start_time()');

    const version = versionResult.rows[0]?.version || 'unknown';
    const startTime = new Date(uptimeResult.rows[0]?.pg_postmaster_start_time);
    const uptime = Math.floor((Date.now() - startTime.getTime()) / 1000);

    return {
      type: 'postgres',
      version,
      uptime,
      host: this.config.host,
      port: this.config.port,
    };
  }

  async getServerStats(): Promise<DatabaseServerStats> {
    if (!this.pool) await this.initialize();

    const connResult = await this.pool!.query(`
      SELECT
        (SELECT count(*) FROM pg_stat_activity) AS active,
        (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_conn
    `);

    const statsResult = await this.pool!.query(`
      SELECT
        SUM(xact_commit + xact_rollback) AS total_queries,
        SUM(numbackends) AS backends
      FROM pg_stat_database
    `);

    const uptimeResult = await this.pool!.query('SELECT pg_postmaster_start_time()');
    const startTime = new Date(uptimeResult.rows[0]?.pg_postmaster_start_time);
    const uptime = Math.max(1, Math.floor((Date.now() - startTime.getTime()) / 1000));

    const memResult = await this.pool!.query(`
      SELECT
        (SELECT setting::bigint * 8192 FROM pg_settings WHERE name = 'shared_buffers') AS shared_buffers
    `);

    const totalQueries = parseInt(statsResult.rows[0]?.total_queries || '0', 10);
    const active = parseInt(connResult.rows[0]?.active || '0', 10);
    const maxConn = parseInt(connResult.rows[0]?.max_conn || '0', 10);

    return {
      connections: {
        active,
        max: maxConn,
        total: totalQueries,
      },
      queries: {
        total: totalQueries,
        perSecond: Math.round((totalQueries / uptime) * 100) / 100,
      },
      threads: {
        running: active,
        cached: 0,
        connected: active,
      },
      memory: {
        bufferPoolSize: parseInt(memResult.rows[0]?.shared_buffers || '0', 10),
        bufferPoolUsed: 0,
      },
    };
  }

  async getDatabasesWithDetails(): Promise<DatabaseDetail[]> {
    if (!this.pool) await this.initialize();

    const result = await this.pool!.query(`
      SELECT
        d.datname AS name,
        pg_database_size(d.datname) AS "sizeBytes"
      FROM pg_database d
      WHERE d.datistemplate = false
      ORDER BY pg_database_size(d.datname) DESC
    `);

    const prefix = this.config.dbPrefix + '_';
    return result.rows.map((row) => ({
      name: row.name,
      sizeBytes: parseInt(row.sizeBytes, 10),
      tableCount: 0,
      isTenantDb: row.name.startsWith(prefix),
    }));
  }

  async getProcessList(): Promise<DatabaseProcess[]> {
    if (!this.pool) await this.initialize();

    const result = await this.pool!.query(`
      SELECT
        pid,
        usename,
        datname,
        client_addr,
        state,
        COALESCE(EXTRACT(EPOCH FROM now() - query_start)::int, 0) AS time,
        query
      FROM pg_stat_activity
      WHERE pid <> pg_backend_pid()
      ORDER BY COALESCE(query_start, backend_start) ASC
    `);

    return result.rows.map((row) => ({
      id: row.pid,
      user: row.usename || '',
      database: row.datname || null,
      host: row.client_addr || 'local',
      command: row.state || 'unknown',
      time: row.time || 0,
      state: row.state || '',
      query: row.query || null,
    }));
  }

  async killProcess(id: number): Promise<void> {
    if (!this.pool) await this.initialize();
    await this.pool!.query('SELECT pg_terminate_backend($1)', [id]);
  }
}
