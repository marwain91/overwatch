import mysql from 'mysql2/promise';
import { exec } from 'child_process';
import { promisify } from 'util';
import { DatabaseAdapter, DatabaseAdapterConfig } from './types';

const execAsync = promisify(exec);

/**
 * MySQL/MariaDB database adapter
 */
export class MySQLAdapter implements DatabaseAdapter {
  private pool: mysql.Pool | null = null;
  private config: DatabaseAdapterConfig;

  constructor(config: DatabaseAdapterConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    this.pool = mysql.createPool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.rootUser,
      password: this.config.rootPassword,
      waitForConnections: true,
      connectionLimit: 5,
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
      console.error('MySQL connection failed:', error);
      return false;
    }
  }

  async createDatabase(tenantId: string, password: string): Promise<void> {
    if (!this.pool) {
      await this.initialize();
    }

    const dbName = this.getDatabaseName(tenantId);
    const userName = this.getUserName(tenantId);
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

    const pattern = `${this.config.dbPrefix}_%`;
    const [rows] = await this.pool!.query('SHOW DATABASES LIKE ?', [pattern]);
    return (rows as any[]).map(row => Object.values(row)[0] as string);
  }

  async dumpDatabase(tenantId: string, outputPath: string): Promise<void> {
    const dbName = this.getDatabaseName(tenantId);
    const containerName = this.getContainerName();

    // Use docker exec to run mysqldump in the container
    const cmd = `docker exec ${containerName} mysqldump -u ${this.config.rootUser} -p"${this.config.rootPassword}" --single-transaction "${dbName}" > "${outputPath}"`;

    await execAsync(cmd, { maxBuffer: 100 * 1024 * 1024 });
  }

  async restoreDatabase(tenantId: string, inputPath: string): Promise<void> {
    const dbName = this.getDatabaseName(tenantId);
    const containerName = this.getContainerName();

    // Use docker exec to run mysql restore in the container
    const cmd = `docker exec -i ${containerName} mysql -u ${this.config.rootUser} -p"${this.config.rootPassword}" "${dbName}" < "${inputPath}"`;

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
