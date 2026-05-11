import mysql from 'mysql2/promise';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { createReadStream, createWriteStream } from 'fs';
import { DatabaseAdapterConfig, DatabaseServerInfo, DatabaseServerStats, DatabaseDetail, DatabaseProcess } from './types';
import { BaseDatabaseAdapter } from './base';

const execFileAsync = promisify(execFile);

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

    const connection = await this.pool!.getConnection();

    try {
      await connection.query(
        `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
      );
      await connection.query(
        `CREATE USER IF NOT EXISTS '${userName}'@'%' IDENTIFIED BY ?`,
        [password]
      );
      await connection.query(
        `GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${userName}'@'%'`
      );
      await connection.query('FLUSH PRIVILEGES');
    } finally {
      connection.release();
    }
  }

  async dropDatabase(tenantId: string): Promise<void> {
    if (!this.pool) {
      await this.initialize();
    }

    const dbName = this.getDatabaseName(tenantId);
    const userName = this.getUserName(tenantId);

    this.validateIdentifiers(dbName, userName);

    const connection = await this.pool!.getConnection();

    try {
      await connection.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await connection.query(`DROP USER IF EXISTS '${userName}'@'%'`);
      await connection.query('FLUSH PRIVILEGES');
    } finally {
      connection.release();
    }
  }

  async listDatabases(): Promise<string[]> {
    if (!this.pool) {
      await this.initialize();
    }

    const pattern = this.config.dbPrefix ? `${this.config.dbPrefix}_%` : '%';
    const [rows] = await this.pool!.query('SHOW DATABASES LIKE ?', [pattern]);
    return (rows as any[]).map(row => Object.values(row)[0] as string);
  }

  async dumpDatabase(tenantId: string, outputPath: string): Promise<void> {
    const dbName = this.getDatabaseName(tenantId);
    const containerName = this.getContainerName();

    // Stream mysqldump's stdout directly to disk. Previously we buffered the
    // entire dump in memory via execFile (with a 100 MB cap), which broke for
    // any DB whose dump exceeded that — and crashed the Overwatch container
    // for very large dumps even before the cap. spawn + pipe handles arbitrary
    // sizes. Password is passed via MYSQL_PWD env, never as an argv flag.
    return new Promise<void>((resolve, reject) => {
      const proc = spawn('docker', [
        'exec', '-e', `MYSQL_PWD=${this.config.rootPassword}`,
        containerName, 'mysqldump', '-u', this.config.rootUser,
        '--single-transaction', dbName,
      ]);

      const out = createWriteStream(outputPath, { mode: 0o600 });
      proc.stdout.pipe(out);

      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      const fail = (err: Error) => { out.destroy(); reject(err); };
      proc.on('error', fail);
      out.on('error', fail);
      proc.on('close', (code) => {
        out.end();
        if (code === 0) resolve();
        else reject(new Error(`mysqldump exited ${code}: ${stderr.slice(0, 1000)}`));
      });
    });
  }

  async restoreDatabase(tenantId: string, inputPath: string): Promise<void> {
    const dbName = this.getDatabaseName(tenantId);
    const containerName = this.getContainerName();

    // Use spawn (no shell) with stdin pipe to avoid password injection
    return new Promise<void>((resolve, reject) => {
      const proc = spawn('docker', [
        'exec', '-i', '-e', `MYSQL_PWD=${this.config.rootPassword}`,
        containerName, 'mysql', '-u', this.config.rootUser, dbName,
      ]);

      const input = createReadStream(inputPath);
      input.pipe(proc.stdin);

      let stderr = '';
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`mysql restore exited with code ${code}: ${stderr}`));
      });
      proc.on('error', reject);
    });
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
