import { spawn } from 'child_process';
import { createReadStream, createWriteStream } from 'fs';
import { DatabaseAdapter, DatabaseAdapterConfig, DatabaseServerInfo, DatabaseServerStats, DatabaseDetail, DatabaseProcess, CreateDatabaseResult } from './types';
import { assertSafeIdentifier } from '../../utils/security';
import { getDockerEnv, runDocker } from '../../utils/runDocker';

/** Restore errors keep only the tail of the client's stderr (where the actual failure is). */
export const STDERR_TAIL_BYTES = 2048;

/**
 * Upper bound for one dump or restore, the same as for the restic backup and
 * restore that move the same data (RESTIC_LONG_TIMEOUT_MS in services/backup.ts).
 * A hung client would otherwise block every later scheduled backup of the app,
 * or hold the tenant lock of a restore forever.
 */
export const DB_CLIENT_TIMEOUT_MS = 3_600_000;
/** Seconds the in-container `timeout` waits after SIGTERM before SIGKILL. */
const IN_CONTAINER_KILL_AFTER_S = 30;
/** The local `docker exec` outlives the in-container timeout by this much, so the client's own exit is seen first. */
const LOCAL_KILL_GRACE_MS = 60_000;

export interface DbClientRun {
  /** `docker exec` options before the container name, e.g. ['-e', 'MYSQL_PWD']. */
  execOptions: string[];
  /** The client command inside the container. */
  argv: string[];
  /** Extra env for the local `docker exec` (the values `-e NAME` forwards). */
  env: Record<string, string>;
  /** Name used in error messages, e.g. 'mysqldump'. */
  label: string;
}

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
    return this.config.dbPrefix ? `${this.config.dbPrefix}_${tenantId}` : tenantId;
  }

  getUserName(tenantId: string): string {
    return this.config.dbPrefix ? `${this.config.dbPrefix}_${tenantId}` : tenantId;
  }

  getContainerName(): string {
    return this.config.containerName;
  }

  /** Overridable for tests. */
  protected clientTimeoutMs = DB_CLIENT_TIMEOUT_MS;
  protected localKillGraceMs = LOCAL_KILL_GRACE_MS;
  private containerHasTimeout = false;

  /**
   * `timeout ...` prefix for a client run inside the DB container. Killing the
   * local `docker exec` leaves the process inside the container running, so the
   * limit has to be enforced in there. The official mariadb, mysql and postgres
   * (incl. alpine) images ship `timeout`; a custom image without it still works,
   * with only the local kill.
   */
  private async inContainerTimeout(): Promise<string[]> {
    const seconds = String(Math.ceil(this.clientTimeoutMs / 1000));
    const prefix = ['timeout', '-k', String(IN_CONTAINER_KILL_AFTER_S), seconds];
    if (!this.containerHasTimeout) {
      try {
        // Same syntax as the real call: BusyBox and GNU both take `-k N SECS`.
        await runDocker('docker', ['exec', this.config.containerName, 'timeout', '-k', '1', '5', 'true'], { timeoutMs: 30_000 });
        this.containerHasTimeout = true;
      } catch (err: any) {
        console.warn(`[db] No usable \`timeout\` in container ${this.config.containerName} (${err?.message || err}); dump/restore clients there are only killed locally when they hang.`);
        return [];
      }
    }
    return prefix;
  }

  private async clientArgs(run: DbClientRun, interactive: boolean): Promise<string[]> {
    return ['exec', ...(interactive ? ['-i'] : []), ...run.execOptions, this.config.containerName, ...(await this.inContainerTimeout()), ...run.argv];
  }

  /** Allowlisted env only: Overwatch's own env holds JWT_SECRET and other operator secrets. */
  private clientEnv(run: DbClientRun): NodeJS.ProcessEnv {
    return { ...getDockerEnv(), ...run.env };
  }

  /** Local backstop: kill the `docker exec` when the in-container timeout did not end it. */
  private armLocalTimeout(proc: ReturnType<typeof spawn>, run: DbClientRun, fail: (err: Error) => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      fail(new Error(`${run.label} timed out after ${Math.round(this.clientTimeoutMs / 1000)}s`));
    }, this.clientTimeoutMs + this.localKillGraceMs);
    timer.unref();
    return timer;
  }

  /** Run a dump client and stream its stdout to `outputPath` (mode 0600). */
  protected async runDumpToFile(run: DbClientRun, outputPath: string): Promise<void> {
    const args = await this.clientArgs(run, false);

    // Stream the dump straight to disk: buffering it in memory broke for large
    // databases. Passwords travel as `-e NAME` with the value in the env, never in argv.
    return new Promise<void>((resolve, reject) => {
      const proc = spawn('docker', args, { env: this.clientEnv(run) });

      const out = createWriteStream(outputPath, { mode: 0o600 });
      proc.stdout!.pipe(out);

      let stderr = '';
      proc.stderr!.on('data', (d) => { if (stderr.length < 4096) stderr += d.toString(); });

      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve();
      };
      const fail = (err: Error) => { proc.kill(); out.destroy(); done(err); };
      const timer = this.armLocalTimeout(proc, run, fail);
      proc.on('error', fail);
      out.on('error', fail);
      proc.on('close', (code) => {
        if (code !== 0) {
          out.end();
          done(new Error(`${run.label} exited ${code}${code === 124 ? ' (timed out)' : ''}: ${stderr.slice(0, 1000)}`));
          return;
        }
        // Resolve only once the dump is on disk: a write that fails on the
        // final flush must fail the backup, not archive a truncated dump.
        if (out.writableFinished) done();
        else { out.once('finish', () => done()); out.end(); }
      });
    });
  }

  /** Run a restore client with `inputPath` on its stdin. */
  protected async runRestoreFromFile(run: DbClientRun, inputPath: string): Promise<void> {
    const args = await this.clientArgs(run, true);

    return new Promise<void>((resolve, reject) => {
      const proc = spawn('docker', args, { env: this.clientEnv(run) });
      const input = createReadStream(inputPath);

      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // A client that stopped early leaves the dump half read: close the file.
        input.destroy();
        if (err) reject(err); else resolve();
      };
      const timer = this.armLocalTimeout(proc, run, done);

      // Both streams need error listeners: an unhandled stream error is
      // uncaught and kills the process. The client closes stdin early when it
      // stops at a SQL error (EPIPE here; its exit code and stderr say why).
      input.on('error', (err) => { proc.kill(); done(err); });
      proc.stdin!.on('error', () => {});
      input.pipe(proc.stdin!);

      let stderr = '';
      proc.stderr!.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-STDERR_TAIL_BYTES); });
      proc.on('close', (code) => {
        if (code === 0) done();
        else done(new Error(`${run.label} exited with code ${code}${code === 124 ? ' (timed out)' : ''}: ${stderr}`));
      });
      proc.on('error', done);
    });
  }

  abstract createDatabase(tenantId: string, password: string): Promise<CreateDatabaseResult>;
  abstract databaseExists(tenantId: string): Promise<boolean>;
  abstract dropDatabase(tenantId: string, options?: { keepUser?: boolean }): Promise<void>;
  abstract resetDatabase(tenantId: string): Promise<void>;
  abstract listDatabases(): Promise<string[]>;
  abstract dumpDatabase(tenantId: string, outputPath: string): Promise<void>;
  abstract restoreDatabase(tenantId: string, inputPath: string): Promise<void>;
  abstract getServerInfo(): Promise<DatabaseServerInfo>;
  abstract getServerStats(): Promise<DatabaseServerStats>;
  abstract getDatabasesWithDetails(): Promise<DatabaseDetail[]>;
  abstract getProcessList(): Promise<DatabaseProcess[]>;
  abstract killProcess(id: number): Promise<void>;
}
