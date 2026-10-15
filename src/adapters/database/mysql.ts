import mysql from 'mysql2/promise';
import { DatabaseServerInfo, DatabaseServerStats, DatabaseDetail, DatabaseProcess, CreateDatabaseResult } from './types';
import { BaseDatabaseAdapter } from './base';

/**
 * A database name as a database-level GRANT/REVOKE pattern: `_` and `%` are
 * wildcards there, so `p_t1` would also match a database named `pXt1`.
 */
function grantDbPattern(dbName: string): string {
  return dbName.replace(/[\\_%]/g, '\\$&');
}

/**
 * MySQL/MariaDB database adapter
 */
export class MySQLAdapter extends BaseDatabaseAdapter {
  protected declare pool: mysql.Pool | null;

  protected get maxIdentifierLength(): number {
    return 64;
  }

  protected createPool(): mysql.Pool {
    return mysql.createPool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.rootUser,
      password: this.config.rootPassword,
      waitForConnections: true,
      connectionLimit: 5,
      connectTimeout: 10000,
      queueLimit: 50,
    });
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
    const [rows] = await this.pool!.query(
      'SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [dbName]
    );
    return (rows as any[]).length > 0;
  }

  async createDatabase(tenantId: string, password: string): Promise<CreateDatabaseResult> {
    if (!this.pool) {
      await this.initialize();
    }

    const dbName = this.getDatabaseName(tenantId);
    const userName = this.getUserName(tenantId);

    this.validateIdentifiers(dbName, userName);

    const connection = await this.pool!.getConnection();
    let created = false;
    let userCreated = false;
    let grantAttempted = false;

    try {
      const [dbRows] = await connection.query(
        'SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
        [dbName]
      );
      if ((dbRows as any[]).length === 0) {
        await connection.query(
          `CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
        );
        created = true;
      }

      const [userRows] = await connection.query(
        `SELECT 1 FROM mysql.user WHERE User = ? AND Host = '%'`,
        [userName]
      );
      if ((userRows as any[]).length === 0) {
        await connection.query(`CREATE USER '${userName}'@'%' IDENTIFIED BY ?`, [password]);
        userCreated = true;
      } else {
        // Pre-existing user: set the password so it matches the .env we write
        await connection.query(`ALTER USER '${userName}'@'%' IDENTIFIED BY ?`, [password]);
      }

      grantAttempted = true;
      await connection.query(
        `GRANT ALL PRIVILEGES ON \`${grantDbPattern(dbName)}\`.* TO '${userName}'@'%'`
      );
      await connection.query('FLUSH PRIVILEGES');
      return { created, userCreated };
    } catch (error) {
      // Undo only what this call created; never touch pre-existing objects.
      // A pre-existing user keeps its account, but a grant on the database we
      // are about to drop would otherwise linger and apply to a future database
      // with the same name.
      if (created && !userCreated && grantAttempted) {
        await connection.query(`REVOKE ALL PRIVILEGES ON \`${grantDbPattern(dbName)}\`.* FROM '${userName}'@'%'`).catch(() => {});
      }
      if (created) await connection.query(`DROP DATABASE IF EXISTS \`${dbName}\``).catch(() => {});
      if (userCreated) await connection.query(`DROP USER IF EXISTS '${userName}'@'%'`).catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  async dropDatabase(tenantId: string, options: { keepUser?: boolean } = {}): Promise<void> {
    if (!this.pool) {
      await this.initialize();
    }

    const dbName = this.getDatabaseName(tenantId);
    const userName = this.getUserName(tenantId);

    this.validateIdentifiers(dbName, userName);

    const connection = await this.pool!.getConnection();

    try {
      await connection.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
      if (!options.keepUser) {
        await connection.query(`DROP USER IF EXISTS '${userName}'@'%'`);
      }
      await connection.query('FLUSH PRIVILEGES');
    } finally {
      connection.release();
    }
  }

  async listDatabases(): Promise<string[]> {
    if (!this.pool) {
      await this.initialize();
    }

    const prefix = this.config.dbPrefix ? `${this.config.dbPrefix}_` : '';
    const [rows] = await this.pool!.query('SHOW DATABASES LIKE ?', [`${prefix}%`]);
    const names = (rows as any[]).map(row => Object.values(row)[0] as string);
    // `_` is a LIKE wildcard, so the pattern alone over-matches
    // (prefix "a_b" also matches "aXb_t1"); keep only true prefix matches.
    return prefix ? names.filter(n => n.startsWith(prefix)) : names;
  }

  async dumpDatabase(tenantId: string, outputPath: string): Promise<void> {
    const dbName = this.getDatabaseName(tenantId);
    // --routines/--events: stored procedures, functions and events are not
    // dumped by default (triggers are). MYSQL_PWD is named in argv but its
    // value comes from the spawned process env, so it never shows up in `ps`.
    return this.runDumpToFile({
      execOptions: ['-e', 'MYSQL_PWD'],
      argv: ['mysqldump', '-u', this.config.rootUser, '--single-transaction', '--routines', '--events', dbName],
      env: { MYSQL_PWD: this.config.rootPassword },
      label: 'mysqldump',
    }, outputPath);
  }

  async restoreDatabase(tenantId: string, inputPath: string): Promise<void> {
    const dbName = this.getDatabaseName(tenantId);
    // spawn (no shell) with stdin pipe; password goes via env, not argv
    return this.runRestoreFromFile({
      execOptions: ['-e', 'MYSQL_PWD'],
      argv: ['mysql', '-u', this.config.rootUser, dbName],
      env: { MYSQL_PWD: this.config.rootPassword },
      label: 'mysql restore',
    }, inputPath);
  }

  async getServerInfo(): Promise<DatabaseServerInfo> {
    if (!this.pool) await this.initialize();

    const [versionRows] = await this.pool!.query("SHOW VARIABLES LIKE 'version'");
    const [uptimeRows] = await this.pool!.query("SHOW STATUS LIKE 'Uptime'");

    const version = (versionRows as any[])[0]?.Value || 'unknown';
    const uptime = parseInt((uptimeRows as any[])[0]?.Value || '0', 10);

    return {
      type: this.config.type as 'mysql' | 'mariadb',
      version,
      uptime,
      host: this.config.host,
      port: this.config.port,
    };
  }

  async getServerStats(): Promise<DatabaseServerStats> {
    if (!this.pool) await this.initialize();

    const [statusRows] = await this.pool!.query('SHOW GLOBAL STATUS');
    const statusMap = new Map<string, string>();
    for (const row of statusRows as any[]) {
      statusMap.set(row.Variable_name, row.Value);
    }

    const [varRows] = await this.pool!.query("SHOW VARIABLES WHERE Variable_name IN ('max_connections', 'innodb_buffer_pool_size')");
    const varMap = new Map<string, string>();
    for (const row of varRows as any[]) {
      varMap.set(row.Variable_name, row.Value);
    }

    const uptime = parseInt(statusMap.get('Uptime') || '1', 10);
    const totalQueries = parseInt(statusMap.get('Queries') || '0', 10);

    return {
      connections: {
        active: parseInt(statusMap.get('Threads_connected') || '0', 10),
        max: parseInt(varMap.get('max_connections') || '0', 10),
        total: parseInt(statusMap.get('Connections') || '0', 10),
      },
      queries: {
        total: totalQueries,
        perSecond: Math.round((totalQueries / uptime) * 100) / 100,
      },
      threads: {
        running: parseInt(statusMap.get('Threads_running') || '0', 10),
        cached: parseInt(statusMap.get('Threads_cached') || '0', 10),
        connected: parseInt(statusMap.get('Threads_connected') || '0', 10),
      },
      memory: {
        bufferPoolSize: parseInt(varMap.get('innodb_buffer_pool_size') || '0', 10),
        bufferPoolUsed: parseInt(statusMap.get('Innodb_buffer_pool_bytes_data') || '0', 10),
      },
    };
  }

  async getDatabasesWithDetails(): Promise<DatabaseDetail[]> {
    if (!this.pool) await this.initialize();

    const [rows] = await this.pool!.query(`
      SELECT
        s.SCHEMA_NAME AS name,
        COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0) AS sizeBytes,
        COUNT(t.TABLE_NAME) AS tableCount
      FROM information_schema.SCHEMATA s
      LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
      WHERE s.SCHEMA_NAME NOT IN ('information_schema', 'performance_schema', 'mysql', 'sys')
      GROUP BY s.SCHEMA_NAME
      ORDER BY sizeBytes DESC
    `);

    const prefix = this.config.dbPrefix ? this.config.dbPrefix + '_' : '';
    return (rows as any[]).map((row) => ({
      name: row.name,
      sizeBytes: parseInt(row.sizeBytes, 10),
      tableCount: parseInt(row.tableCount, 10),
      isTenantDb: prefix ? row.name.startsWith(prefix) : true,
    }));
  }

  async getProcessList(): Promise<DatabaseProcess[]> {
    if (!this.pool) await this.initialize();

    const [rows] = await this.pool!.query('SELECT * FROM information_schema.PROCESSLIST ORDER BY TIME DESC');
    return (rows as any[]).map((row) => ({
      id: row.ID,
      user: row.USER,
      database: row.DB || null,
      host: row.HOST,
      command: row.COMMAND,
      time: row.TIME,
      state: row.STATE || '',
      query: row.INFO || null,
    }));
  }

  async killProcess(id: number): Promise<void> {
    if (!this.pool) await this.initialize();
    await this.pool!.query('KILL ?', [id]);
  }
}
