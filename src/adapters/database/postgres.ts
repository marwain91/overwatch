import { Pool } from 'pg';
import { DatabaseServerInfo, DatabaseServerStats, DatabaseDetail, DatabaseProcess, CreateDatabaseResult } from './types';
import { BaseDatabaseAdapter } from './base';

/**
 * PostgreSQL database adapter
 */
export class PostgresAdapter extends BaseDatabaseAdapter {
  protected declare pool: Pool | null;

  protected get maxIdentifierLength(): number {
    return 63;
  }

  protected createPool(): Pool {
    const pool = new Pool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.rootUser,
      password: this.config.rootPassword,
      database: 'postgres', // Connect to default db for admin operations
      max: 5,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      // Admin queries only; dumps/restores run via docker exec, not this pool.
      statement_timeout: 30000,
    });
    // pg emits 'error' when an idle pooled client dies (DB restart,
    // pg_terminate_backend). With no listener that EventEmitter error is
    // thrown and takes the whole process down; the pool replaces the client.
    pool.on('error', (err) => {
      console.error(`[postgres] idle client error: ${err.message}`);
    });
    return pool;
  }

  protected async executeTestQuery(): Promise<void> {
    await this.pool!.query('SELECT 1');
  }

  async databaseExists(tenantId: string): Promise<boolean> {
    if (!this.pool) {
      await this.initialize();
    }
    const dbName = this.getDatabaseName(tenantId);
    this.validateIdentifiers(dbName, this.getUserName(tenantId));
    const result = await this.pool!.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName]);
    return result.rows.length > 0;
  }

  async createDatabase(tenantId: string, password: string): Promise<CreateDatabaseResult> {
    if (!this.pool) {
      await this.initialize();
    }

    const dbName = this.getDatabaseName(tenantId);
    const userName = this.getUserName(tenantId);

    this.validateIdentifiers(dbName, userName);

    const client = await this.pool!.connect();
    // CREATE DATABASE cannot use parameterized queries; escape identifiers as defense-in-depth
    const safeDb = dbName.replace(/"/g, '""');
    const safeUser = userName.replace(/"/g, '""');
    let created = false;
    let userCreated = false;

    try {
      // Use format() with %I for identifiers and %L for literals to prevent SQL injection
      const roleExists = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [userName]);
      if (roleExists.rows.length === 0) {
        await client.query(`
          DO $body$ BEGIN
            EXECUTE format('CREATE USER %I WITH PASSWORD %L', $1, $2);
          END $body$;
        `, [userName, password]);
        userCreated = true;
      } else {
        await client.query(`
          DO $body$ BEGIN
            EXECUTE format('ALTER USER %I WITH PASSWORD %L', $1, $2);
          END $body$;
        `, [userName, password]);
      }

      const dbExists = await client.query(
        `SELECT 1 FROM pg_database WHERE datname = $1`,
        [dbName]
      );

      if (dbExists.rows.length === 0) {
        await client.query(`CREATE DATABASE "${safeDb}" OWNER "${safeUser}"`);
        created = true;
      }

      // Grant privileges
      await client.query(`GRANT ALL PRIVILEGES ON DATABASE "${safeDb}" TO "${safeUser}"`);

      // New databases are connectable by PUBLIC, so any tenant role could open
      // another tenant's DB. Restrict CONNECT to the owning role; runs for
      // existing databases too so they are tightened on the next createDatabase.
      await client.query(`REVOKE CONNECT ON DATABASE "${safeDb}" FROM PUBLIC`);
      await client.query(`GRANT CONNECT ON DATABASE "${safeDb}" TO "${safeUser}"`);
      return { created, userCreated };
    } catch (error) {
      // Undo only what this call created; never touch pre-existing objects
      if (created) await client.query(`DROP DATABASE IF EXISTS "${safeDb}"`).catch(() => {});
      if (userCreated) await client.query(`DROP USER IF EXISTS "${safeUser}"`).catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async dropDatabase(tenantId: string, options: { keepUser?: boolean } = {}): Promise<void> {
    if (!this.pool) {
      await this.initialize();
    }

    const dbName = this.getDatabaseName(tenantId);
    const userName = this.getUserName(tenantId);

    this.validateIdentifiers(dbName, userName);

    const client = await this.pool!.connect();
    let releaseError: Error | undefined;

    try {
      // The admin pool's 30s statement_timeout must not cut off a large DROP
      await client.query('SET statement_timeout = 0');

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

      if (!options.keepUser) {
        await client.query(`DROP USER IF EXISTS "${safeUser}"`);
      }
    } finally {
      // Restore the pool default; if that fails, discard the client instead of pooling it
      try {
        await client.query('RESET statement_timeout');
      } catch (err) {
        releaseError = err instanceof Error ? err : new Error(String(err));
      }
      client.release(releaseError);
    }
  }

  async listDatabases(): Promise<string[]> {
    if (!this.pool) {
      await this.initialize();
    }

    const prefix = this.config.dbPrefix ? `${this.config.dbPrefix}_` : '';
    const result = await this.pool!.query(
      `SELECT datname FROM pg_database WHERE datname LIKE $1 AND datname NOT IN ('postgres', 'template0', 'template1')`,
      [`${prefix}%`]
    );
    const names: string[] = result.rows.map(row => row.datname);
    // `_` is a LIKE wildcard, so the pattern alone over-matches
    // (prefix "a_b" also matches "aXb_t1"); keep only true prefix matches.
    return prefix ? names.filter(n => n.startsWith(prefix)) : names;
  }

  async dumpDatabase(tenantId: string, outputPath: string): Promise<void> {
    const dbName = this.getDatabaseName(tenantId);
    // --no-owner/--no-privileges: the dump must not name the source tenant's
    // role, or a restore into another tenant hands that role the objects.
    // PGPASSWORD is named in argv but its value comes from the spawned process
    // env, so the password never shows up in `ps` output.
    return this.runDumpToFile({
      execOptions: ['-e', 'PGPASSWORD'],
      argv: ['pg_dump', '-U', this.config.rootUser, '--no-owner', '--no-privileges', '-d', dbName],
      env: { PGPASSWORD: this.config.rootPassword },
      label: 'pg_dump',
    }, outputPath);
  }

  async restoreDatabase(tenantId: string, inputPath: string): Promise<void> {
    const dbName = this.getDatabaseName(tenantId);
    const role = this.getUserName(tenantId);
    this.validateIdentifiers(dbName, role);
    // ON_ERROR_STOP + one transaction: without them psql reports success after
    // SQL errors and leaves a half-applied dump. A --no-owner dump's objects
    // belong to whoever creates them, so the dump runs as the tenant's role
    // (SET ROLE inside the same transaction). Dumps from older versions carry
    // OWNER TO statements naming the dumped tenant's role, which that same role
    // may run on its own objects; one naming another tenant's role fails.
    return this.runRestoreFromFile({
      execOptions: ['-e', 'PGPASSWORD'],
      argv: [
        'psql', '-U', this.config.rootUser, '-d', dbName,
        '-v', 'ON_ERROR_STOP=1', '--single-transaction',
        '-c', `SET ROLE "${role}"`, '-f', '-',
      ],
      env: { PGPASSWORD: this.config.rootPassword },
      label: 'psql restore',
    }, inputPath);
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

    const prefix = this.config.dbPrefix ? this.config.dbPrefix + '_' : '';
    const systemDbs = new Set(['postgres', 'template0', 'template1']);
    return result.rows.map((row) => ({
      name: row.name,
      sizeBytes: parseInt(row.sizeBytes, 10),
      tableCount: 0,
      isTenantDb: prefix ? row.name.startsWith(prefix) : !systemDbs.has(row.name),
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
