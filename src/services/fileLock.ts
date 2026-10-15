import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getDataDir } from '../config';
import { ConflictError } from '../utils/httpErrors';

// Process-local serialisation layer — prevents re-entrant acquisition within the
// same process (node-cron tick + an HTTP request both hitting the same key).
const inProcess = new Map<string, Promise<void>>();

// Stale-lock threshold: a lockfile whose mtime is older than this, written by a
// PID that does not exist here, belongs to a holder that is gone.
const STALE_LOCK_MS = 60_000;

// Holders refresh the lockfile's mtime this often. A live holder whose PID is
// invisible here (host CLI vs. container: separate PID namespaces) therefore
// never looks stale, however long it holds the lock.
const HEARTBEAT_MS = 10_000;

// A reclaim that keeps racing (or keeps failing) hands back to the caller's
// backoff loop, which honours the wait deadline.
const MAX_RECLAIM_ATTEMPTS = 3;

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

interface HeldLock {
  /** Kept open so the heartbeat touches our own file even if the path is taken over. */
  fd: number;
  /** Exact content we wrote; the last line is a per-acquisition token. */
  content: string;
}

function createLockfile(lp: string): HeldLock | null {
  let fd: number;
  try {
    fd = fs.openSync(lp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  } catch (err: any) {
    if (err.code === 'EEXIST') return null;
    throw err;
  }
  const content = `${process.pid}\n${Date.now()}\n${INSTANCE_ID}\n${randomUUID()}\n`;
  try {
    fs.writeSync(fd, content);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(lp, { force: true });
    throw err;
  }
  return { fd, content };
}

interface LockSnapshot {
  ino: number;
  mtimeMs: number;
  content: string;
}

/** Inode, mtime and content read through one descriptor, so they describe the same file. */
async function snapshotLockfile(file: string): Promise<LockSnapshot | null> {
  let fh: fsp.FileHandle;
  try {
    fh = await fsp.open(file, 'r');
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const st = await fh.stat();
    return { ino: st.ino, mtimeMs: st.mtimeMs, content: await fh.readFile('utf-8') };
  } finally {
    await fh.close();
  }
}

function isStale(snap: LockSnapshot): boolean {
  const [pidStr, tsStr, instanceId] = snap.content.split('\n');
  const pid = Number(pidStr);
  const ts = Number(tsStr);
  if (pid === process.pid) {
    // Same PID. Our own instance id: a leftover of this process (every
    // in-process holder is serialised by `inProcess` before it gets here).
    // Any other id (or none, from before ids existed) belongs to a previous
    // run only if the file predates this process; otherwise another
    // container sharing the data dir wrote it and it may be live.
    return instanceId === INSTANCE_ID || (Number.isFinite(ts) && ts < PROCESS_START_MS);
  }
  return !isPidAlive(pid) && Date.now() - snap.mtimeMs >= STALE_LOCK_MS;
}

const sameFile = (a: LockSnapshot, b: LockSnapshot) =>
  a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.content === b.content;

/**
 * Remove `lp` if it is stale. Returns true when the path is (probably) free to
 * create, false when a live holder has it.
 *
 * Two reclaimers can both judge the same file stale; one of them may already
 * have replaced it with its own fresh lock by the time the other acts. So the
 * file is first claimed by an atomic rename to a name only we know, and only
 * deleted if it is still exactly the file we judged. Anything else is put back.
 */
async function reclaimIfStale(lp: string): Promise<boolean> {
  const snap = await snapshotLockfile(lp);
  if (!snap) return true;
  if (!isStale(snap)) return false;
  const claimed = `${lp}.stale-${randomUUID()}`;
  try {
    await fsp.rename(lp, claimed);
  } catch (err: any) {
    if (err.code === 'ENOENT') return true;
    throw err;
  }
  const taken = await snapshotLockfile(claimed);
  if (taken && sameFile(taken, snap)) {
    await fsp.unlink(claimed).catch(() => {});
    return true;
  }
  // Not the file we inspected: another process's live lock. link() refuses to
  // overwrite, so a lock created at `lp` in the meantime is never clobbered.
  try {
    await fsp.link(claimed, lp);
  } catch (err: any) {
    if (err.code !== 'EEXIST') await fsp.rename(claimed, lp).catch(() => {});
  }
  await fsp.unlink(claimed).catch(() => {});
  return false;
}

async function tryAcquireLockfile(key: string): Promise<HeldLock | null> {
  const lp = lockPath(key);
  await fsp.mkdir(path.dirname(lp), { recursive: true });
  for (let attempt = 0; attempt < MAX_RECLAIM_ATTEMPTS; attempt++) {
    const held = createLockfile(lp);
    if (held) return held;
    try {
      if (!(await reclaimIfStale(lp))) return null;
    } catch {
      // Unreadable or unremovable lockfile: treat as held; caller will retry.
      return null;
    }
  }
  return null;
}

function startHeartbeat(held: HeldLock): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    const now = new Date();
    fs.futimes(held.fd, now, now, () => {});
  }, HEARTBEAT_MS);
  timer.unref();
  return timer;
}

/** Remove the lockfile only while it is still ours: a reclaimed lock now belongs to someone else. */
async function releaseLockfile(key: string, held: HeldLock): Promise<void> {
  try {
    fs.closeSync(held.fd);
  } catch {
    // Already closed.
  }
  const lp = lockPath(key);
  try {
    if ((await fsp.readFile(lp, 'utf-8')) === held.content) await fsp.unlink(lp);
  } catch {
    // Gone already.
  }
}

/**
 * Cross-process-safe lock keyed by `key`. Two concurrent overwatch processes,
 * or overwatch + a CLI command, will serialise on the same key via an O_EXCL
 * lockfile in <dataDir>/.locks/. Within a single process, an in-memory Map
 * serialises re-entrant calls so we don't deadlock on our own lockfile.
 *
 * Stale lockfiles (a previous run's own PID, or a dead PID whose mtime is older
 * than STALE_LOCK_MS; holders refresh the mtime while they hold the lock) are
 * reclaimed. A caller that cannot get the lock within the wait (30 s by
 * default) fails: queued in-process callers with a ConflictError (409).
 */
export interface LockOptions {
  /** Wait for this long instead of the default (30 s / OVERWATCH_LOCK_TIMEOUT_MS). */
  waitMs?: number;
  /** Do not let this caller's waiting timers keep the process alive (background work). */
  unref?: boolean;
}

export async function withFileLock<T>(key: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const waitMs = opts.waitMs ?? lockWaitMs();
  const unref = (t: ReturnType<typeof setTimeout>) => { if (opts.unref) t.unref(); return t; };
  const deadline = Date.now() + waitMs;

  // In-process wait: if another async task in this process holds the lock, queue
  // behind it, but only until the deadline.
  while (inProcess.has(key)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw busyError(key, waitMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'expired'>(r => { timer = unref(setTimeout(() => r('expired'), remaining)); });
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
    let held: HeldLock | null;
    while (!(held = await tryAcquireLockfile(key))) {
      if (Date.now() > deadline) {
        throw busyError(key, waitMs);
      }
      await new Promise(r => unref(setTimeout(r, delay)));
      delay = Math.min(delay * 2, maxDelay);
    }
    const heartbeat = startHeartbeat(held);
    try {
      return await fn();
    } finally {
      clearInterval(heartbeat);
      await releaseLockfile(key, held);
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
export function withTenantLock<T>(appId: string, tenantId: string, fn: () => Promise<T>, opts?: LockOptions): Promise<T> {
  return withFileLock(`tenant:${appId}/${tenantId}`, fn, opts);
}
