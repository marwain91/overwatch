import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getDataDir } from '../config';
import { ConflictError } from '../utils/httpErrors';

// Process-local serialisation layer — prevents re-entrant acquisition within the
// same process (node-cron tick + an HTTP request both hitting the same key).
const inProcess = new Map<string, Promise<void>>();

// Stale-lock threshold. If a lockfile's content is a PID for a process that no
// longer exists, or the file is older than this and no PID, we consider it stale.
const STALE_LOCK_MS = 60_000;

// Identifies this process lifetime. Overwatch is PID 1 in every container, so
// the PID alone cannot tell "my own earlier run" from "another container that
// shares this data dir"; the instance id and our start time can.
const INSTANCE_ID = randomUUID();
const PROCESS_START_MS = Date.now() - process.uptime() * 1000;

/** How long a caller waits for a lock (in-process queue + lockfile together). Env override: OVERWATCH_LOCK_TIMEOUT_MS. */
function lockWaitMs(): number {
  const override = Number(process.env.OVERWATCH_LOCK_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : 30_000;
}

function busyError(key: string, waitedMs: number): ConflictError {
  const what = key.startsWith('tenant:') ? `Tenant '${key.slice('tenant:'.length)}'` : `Resource '${key}'`;
  return new ConflictError(`${what} is busy: another operation has held it for over ${Math.round(waitedMs / 1000)}s. Try again shortly.`);
}

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
      fs.writeSync(fd, `${process.pid}\n${Date.now()}\n${INSTANCE_ID}\n`);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (err: any) {
    if (err.code !== 'EEXIST') throw err;
    // Stale-lock check: if the pid is dead or file is too old, reclaim.
    try {
      const content = await fsp.readFile(lp, 'utf-8');
      const [pidStr, tsStr, instanceId] = content.split('\n');
      const pid = Number(pidStr);
      const ts = Number(tsStr);
      let alive: boolean;
      let recent: boolean;
      if (pid === process.pid) {
        // Same PID. Our own instance id: a leftover of this process (every
        // in-process holder is serialised by `inProcess` before it gets here).
        // Any other id (or none, from before ids existed) belongs to a previous
        // run only if the file predates this process; otherwise another
        // container sharing the data dir wrote it and it may be live.
        const reclaimable = instanceId === INSTANCE_ID || (Number.isFinite(ts) && ts < PROCESS_START_MS);
        alive = !reclaimable;
        recent = !reclaimable;
      } else {
        alive = isPidAlive(pid);
        recent = Number.isFinite(ts) && Date.now() - ts < STALE_LOCK_MS;
      }
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
 * Stale lockfiles (a previous run's own PID, or dead PID + older than STALE_LOCK_MS)
 * are reclaimed. A caller that cannot get the lock within the wait (30 s by
 * default) fails: queued in-process callers with a ConflictError (409).
 */
export async function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const waitMs = lockWaitMs();
  const deadline = Date.now() + waitMs;

  // In-process wait: if another async task in this process holds the lock, queue
  // behind it, but only until the deadline.
  while (inProcess.has(key)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw busyError(key, waitMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'expired'>(r => { timer = setTimeout(() => r('expired'), remaining); });
    try {
      const outcome = await Promise.race([inProcess.get(key)!.then(() => 'released' as const), expired]);
      if (outcome === 'expired' && inProcess.has(key)) throw busyError(key, waitMs);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  let resolveInProc!: () => void;
  const inProcPromise = new Promise<void>(r => { resolveInProc = r; });
  inProcess.set(key, inProcPromise);

  // Cross-process acquire with exponential backoff.
  let delay = 10;
  const maxDelay = 500;
  try {
    while (!(await tryAcquireLockfile(key))) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out acquiring file lock '${key}' after ${Math.round(waitMs / 1000)}s`);
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

/**
 * Serialise lifecycle operations (create/update/delete/start/stop/restart) on
 * one tenant. Per-tenant key so unrelated tenants never wait on each other.
 */
export function withTenantLock<T>(appId: string, tenantId: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(`tenant:${appId}/${tenantId}`, fn);
}
