import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { getDataDir } from '../config';

// Process-local serialisation layer — prevents re-entrant acquisition within the
// same process (node-cron tick + an HTTP request both hitting the same key).
const inProcess = new Map<string, Promise<void>>();

// Stale-lock threshold. If a lockfile's content is a PID for a process that no
// longer exists, or the file is older than this and no PID, we consider it stale.
const STALE_LOCK_MS = 60_000;

function lockPath(key: string): string {
  const sanitised = key.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(getDataDir(), '.locks', `${sanitised}.lock`);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === 'EPERM';
  }
}

async function tryAcquireLockfile(key: string): Promise<boolean> {
  const lp = lockPath(key);
  await fsp.mkdir(path.dirname(lp), { recursive: true });
  try {
    const fd = fs.openSync(lp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    try {
      fs.writeSync(fd, `${process.pid}\n${Date.now()}\n`);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (err: any) {
    if (err.code !== 'EEXIST') throw err;
    // Stale-lock check: if the pid is dead or file is too old, reclaim.
    try {
      const content = await fsp.readFile(lp, 'utf-8');
      const [pidStr, tsStr] = content.split('\n');
      const pid = Number(pidStr);
      const ts = Number(tsStr);
      const alive = isPidAlive(pid);
      const recent = Number.isFinite(ts) && Date.now() - ts < STALE_LOCK_MS;
      if (!alive && !recent) {
        await fsp.unlink(lp).catch(() => {});
        return tryAcquireLockfile(key);
      }
    } catch {
      // Unreadable lockfile: treat as held; caller will retry.
    }
    return false;
  }
}

async function releaseLockfile(key: string): Promise<void> {
  await fsp.unlink(lockPath(key)).catch(() => {});
}

/**
 * Cross-process-safe lock keyed by `key`. Two concurrent overwatch processes,
 * or overwatch + a CLI command, will serialise on the same key via an O_EXCL
 * lockfile in <dataDir>/.locks/. Within a single process, an in-memory Map
 * serialises re-entrant calls so we don't deadlock on our own lockfile.
 *
 * Stale lockfiles (dead PID + older than STALE_LOCK_MS) are reclaimed.
 */
export async function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  // In-process wait: if another async task in this process holds the lock, queue.
  while (inProcess.has(key)) {
    await inProcess.get(key);
  }

  let resolveInProc!: () => void;
  const inProcPromise = new Promise<void>(r => { resolveInProc = r; });
  inProcess.set(key, inProcPromise);

  // Cross-process acquire with exponential backoff.
  let delay = 10;
  const maxDelay = 500;
  const deadline = Date.now() + 30_000;
  try {
    while (!(await tryAcquireLockfile(key))) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out acquiring file lock '${key}' after 30s`);
      }
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 2, maxDelay);
    }
    try {
      return await fn();
    } finally {
      await releaseLockfile(key);
    }
  } finally {
    inProcess.delete(key);
    resolveInProc();
  }
}
