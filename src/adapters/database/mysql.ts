import mysql from 'mysql2/promise';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { createReadStream } from 'fs';
import { DatabaseAdapterConfig } from './types';
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

    const pattern = `${this.config.dbPrefix}_%`;
    const [rows] = await this.pool!.query('SHOW DATABASES LIKE ?', [pattern]);
    return (rows as any[]).map(row => Object.values(row)[0] as string);
  }

  async dumpDatabase(tenantId: string, outputPath: string): Promise<void> {
    const dbName = this.getDatabaseName(tenantId);
    const containerName = this.getContainerName();

    // Use execFile (no shell) to avoid password injection; pass password via MYSQL_PWD env
    const { stdout } = await execFileAsync('docker', [
      'exec', '-e', `MYSQL_PWD=${this.config.rootPassword}`,
      containerName, 'mysqldump', '-u', this.config.rootUser,
      '--single-transaction', dbName,
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
}
