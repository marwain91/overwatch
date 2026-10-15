import * as fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getDataDir } from '../config';
import { snapshotDataFiles } from '../config/dataFiles';
import { NotFoundError, ValidationError } from '../utils/httpErrors';
import { withFileLock } from './fileLock';

const SNAPSHOT_DIR = '.snapshots';
const FILES_TO_SNAPSHOT = snapshotDataFiles();

// Directories captured recursively — each becomes a subdir inside the snapshot.
const DIRS_TO_SNAPSHOT = [
  'apps.d',
];
const DEFAULT_RETENTION = 30;

// Boot snapshots are capped on their own, so a crash loop can only rotate
// boot snapshots and never the daily or manual ones taken before it began.
const BOOT_LABEL = 'boot';
const BOOT_RETENTION = 10;
// A restart this soon after the last snapshot would only add a duplicate.
const BOOT_SNAPSHOT_MIN_INTERVAL_MS = 10 * 60_000;

// The locks the writers of the restored files take, in one fixed order
// (applyApp holds 'apps' while it takes 'env-vars').
const RESTORE_LOCKS = ['apps', 'env-vars', 'tenant-overrides', 'admin-users', 'notification-channels'];

export interface SnapshotInfo {
  name: string;
  createdAt: string;
  files: string[];
  totalBytes: number;
}

function snapshotsRoot(): string {
  return path.join(getDataDir(), SNAPSHOT_DIR);
}

/** The snapshot's directory; the name must be a direct child of the snapshots root. */
function snapshotDir(name: string): string {
  const root = path.resolve(snapshotsRoot());
  const dir = path.resolve(root, name);
  if (!name || path.dirname(dir) !== root || path.basename(dir) !== name) {
    throw new ValidationError(`Invalid snapshot name '${name}': use a name from 'overwatch snapshot list'`);
  }
  return dir;
}

const isBootSnapshot = (s: SnapshotInfo) => s.name.endsWith(`_${BOOT_LABEL}`);
const isPreRestoreSnapshot = (s: SnapshotInfo) => s.name.endsWith('_pre-restore');

function isoStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Read a regular file without following symlinks: lstat must say regular
 * file, the open uses O_NOFOLLOW, and the opened inode must be the one lstat
 * saw (a swap in between is caught). Null when it is a symlink or not a
 * regular file. Snapshot and restore often run as root, so following a link
 * would copy any file on the host into the data dir or a snapshot.
 */
async function readRegularFile(file: string): Promise<{ data: Buffer; mode: number } | null> {
  const before = await fs.lstat(file);
  if (!before.isFile()) return null;
  let fh: fs.FileHandle;
  try {
    // O_NONBLOCK: a FIFO swapped in after the lstat must not hang the open.
    fh = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err: any) {
    if (err.code === 'ELOOP') return null;
    throw err;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino) return null;
    return { data: await fh.readFile(), mode: st.mode & 0o777 };
  } finally {
    await fh.close();
  }
}

/** Write a new file (never through an existing path or link), keeping `mode`. */
async function writeNewFile(to: string, data: Buffer, mode: number): Promise<void> {
  await fs.writeFile(to, data, { mode, flag: 'wx' });
  // Preserve permissions exactly (umask) — critical for secret files (0600).
  await fs.chmod(to, mode);
}

/** lstat that maps "missing" to null. */
async function lstatOrNull(p: string) {
  try {
    return await fs.lstat(p);
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function warnSkippedLink(p: string): void {
  console.warn(`[snapshot] Skipping ${p}: a symlink or not a regular file`);
}

async function copyDir(src: string, dest: string): Promise<number> {
  let bytes = 0;
  await fs.mkdir(dest, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      bytes += await copyDir(from, to);
    } else if (entry.isFile()) {
      const file = await readRegularFile(from);
      if (!file) {
        warnSkippedLink(from);
        continue;
      }
      await writeNewFile(to, file.data, file.mode);
      bytes += file.data.length;
    } else if (entry.isSymbolicLink()) {
      warnSkippedLink(from);
    }
  }
  return bytes;
}

export async function createSnapshot(label?: string): Promise<SnapshotInfo> {
  const dataDir = getDataDir();
  const stamp = isoStamp();
  const name = label ? `${stamp}_${label.replace(/[^a-zA-Z0-9._-]/g, '_')}` : stamp;
  const dest = path.join(snapshotsRoot(), name);
  await fs.mkdir(dest, { recursive: true, mode: 0o700 });

  const files: string[] = [];
  let totalBytes = 0;
  for (const file of FILES_TO_SNAPSHOT) {
    const src = path.join(dataDir, file);
    const stat = await lstatOrNull(src);
    if (!stat || stat.isDirectory()) continue;
    const content = await readRegularFile(src).catch((err: any) => {
      if (err.code === 'ENOENT') return undefined;
      throw err;
    });
    if (content === undefined) continue;
    if (content === null) {
      warnSkippedLink(src);
      continue;
    }
    await writeNewFile(path.join(dest, file), content.data, content.mode);
    files.push(file);
    totalBytes += content.data.length;
  }

  for (const dir of DIRS_TO_SNAPSHOT) {
    const src = path.join(dataDir, dir);
    const stat = await lstatOrNull(src);
    if (!stat) continue;
    if (!stat.isDirectory()) {
      warnSkippedLink(src);
      continue;
    }
    const bytes = await copyDir(src, path.join(dest, dir));
    if (bytes > 0) {
      files.push(dir + '/');
      totalBytes += bytes;
    }
  }

  const info: SnapshotInfo = { name, createdAt: new Date().toISOString(), files, totalBytes };
  await fs.writeFile(path.join(dest, 'snapshot.json'), JSON.stringify(info, null, 2), { mode: 0o644 });
  return info;
}

export async function listSnapshots(): Promise<SnapshotInfo[]> {
  try {
    const entries = await fs.readdir(snapshotsRoot(), { withFileTypes: true });
    const out: SnapshotInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const raw = await fs.readFile(path.join(snapshotsRoot(), entry.name, 'snapshot.json'), 'utf-8');
        // The directory name, not the file's claim, is what prune and restore act on.
        out.push({ ...JSON.parse(raw), name: entry.name });
      } catch {
        // Missing / unreadable snapshot.json — skip
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch (err: any) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * The real path of an existing snapshot directory. Neither `.snapshots` nor
 * the snapshot itself may be a symlink, and the result must be a direct child
 * of the snapshots root.
 */
async function resolveSnapshotDir(name: string): Promise<string> {
  const dir = snapshotDir(name);
  const rootStat = await lstatOrNull(snapshotsRoot());
  const stat = await lstatOrNull(dir);
  if (!rootStat || !stat) throw new NotFoundError(`Snapshot '${name}' not found at ${dir}`);
  if (!rootStat.isDirectory()) throw new ValidationError(`${snapshotsRoot()} is a symlink or not a directory; refusing to restore`);
  if (!stat.isDirectory()) throw new ValidationError(`Snapshot '${name}' is a symlink or not a directory; refusing to restore`);
  const realRoot = await fs.realpath(snapshotsRoot());
  const realDir = await fs.realpath(dir);
  if (path.dirname(realDir) !== realRoot) {
    throw new ValidationError(`Snapshot '${name}' resolves outside ${snapshotsRoot()}; refusing to restore`);
  }
  return realDir;
}

/** Boot-time snapshot: skipped when one was taken recently; prunes right after. */
export async function createBootSnapshot(): Promise<SnapshotInfo | null> {
  const all = await listSnapshots();
  const newest = all[all.length - 1];
  const age = newest ? Date.now() - Date.parse(newest.createdAt) : NaN;
  if (age >= 0 && age < BOOT_SNAPSHOT_MIN_INTERVAL_MS) return null;
  const info = await createSnapshot(BOOT_LABEL);
  await pruneOldSnapshots();
  return info;
}

async function withLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
  if (keys.length === 0) return fn();
  return withFileLock(keys[0], () => withLocks(keys.slice(1), fn));
}

async function regularFileNames(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.filter(e => e.isFile()).map(e => e.name);
}

function linkRefused(snapshotName: string, label: string): ValidationError {
  return new ValidationError(
    `Snapshot '${snapshotName}' holds ${label} as a symlink or non-regular file; refusing to restore it (nothing was restored)`,
  );
}

/** Copy one snapshot file into the staging area, keeping its mode; JSON must parse. */
async function stageFile(snapshotName: string, from: string, to: string, label: string): Promise<void> {
  const file = await readRegularFile(from);
  if (!file) throw linkRefused(snapshotName, label);
  await writeNewFile(to, file.data, file.mode);
  if (label.endsWith('.json')) {
    try {
      JSON.parse(file.data.toString('utf-8'));
    } catch (err: any) {
      throw new ValidationError(`Snapshot '${snapshotName}' holds an unreadable ${label} (${err?.message || err}); nothing was restored`);
    }
  }
}

interface RestorePlan {
  files: Array<{ staged: string; live: string }>;
  dirs: Array<{ staged: string; live: string }>;
}

/** Copy everything to restore into `staging` (same filesystem as the data dir) without touching live state. */
async function stageRestore(name: string, src: string, staging: string): Promise<RestorePlan> {
  const dataDir = getDataDir();
  const plan: RestorePlan = { files: [], dirs: [] };
  // Not recursive: the staging dir must be one we just created.
  await fs.mkdir(staging, { mode: 0o700 });

  for (const file of FILES_TO_SNAPSHOT) {
    const from = path.join(src, file);
    if (!(await lstatOrNull(from))) continue;
    const staged = path.join(staging, file);
    await stageFile(name, from, staged, file);
    plan.files.push({ staged, live: path.join(dataDir, file) });
  }

  for (const dir of DIRS_TO_SNAPSHOT) {
    const from = path.join(src, dir);
    const stat = await lstatOrNull(from);
    if (!stat) continue;
    if (!stat.isDirectory()) throw linkRefused(name, `${dir}/`);
    const live = path.join(dataDir, dir);
    const liveStat = await lstatOrNull(live);
    if (liveStat && !liveStat.isDirectory()) {
      throw new ValidationError(`${live} is a symlink or not a directory; refusing to restore into it (nothing was restored)`);
    }
    const staged = path.join(staging, dir);
    await fs.mkdir(staged, { mode: 0o700 });
    for (const entry of await fs.readdir(from, { withFileTypes: true })) {
      // Subdirectories were never part of apps.d; anything else that is not a regular file is refused.
      if (entry.isDirectory()) continue;
      await stageFile(name, path.join(from, entry.name), path.join(staged, entry.name), `${dir}/${entry.name}`);
    }
    plan.dirs.push({ staged, live });
  }
  return plan;
}

/**
 * Give the staged file the owner of the file it replaces (or of its directory).
 * The CLI often runs as root on the host while the server runs as the data
 * dir's owner, and a root-owned 0600 file would be unreadable to the server.
 */
async function adoptOwner(staged: string, live: string): Promise<void> {
  // A link's owner (or its target's) says nothing about who should read the file.
  const current = await lstatOrNull(live);
  const ref = current?.isFile() ? current : await fs.lstat(path.dirname(live));
  // EPERM as non-root: then the files are ours anyway.
  await fs.chown(staged, ref.uid, ref.gid).catch(() => {});
}

async function replaceWith(staged: string, live: string): Promise<void> {
  await adoptOwner(staged, live);
  await fs.rename(staged, live);
}

/** Rename every staged file into place: each live file is replaced whole, never truncated or missing. */
async function commitRestore(plan: RestorePlan): Promise<void> {
  for (const { staged, live } of plan.files) {
    await replaceWith(staged, live);
  }
  for (const { staged, live } of plan.dirs) {
    // "Last snapshot wins": the directory ends up with exactly the snapshot's files.
    await fs.mkdir(live, { recursive: true });
    const restored = await regularFileNames(staged);
    for (const entry of restored) {
      await replaceWith(path.join(staged, entry), path.join(live, entry));
    }
    const keep = new Set(restored);
    for (const entry of await regularFileNames(live)) {
      if (!keep.has(entry)) await fs.unlink(path.join(live, entry));
    }
  }
}

/**
 * Restore the named snapshot. Under the writers' locks: snapshot the current
 * state first (pre-restore), copy and check everything in a staging directory,
 * and only then rename the files into place. Returns the pre-restore snapshot.
 */
export async function restoreSnapshot(name: string): Promise<SnapshotInfo> {
  const src = await resolveSnapshotDir(name);
  const marker = await lstatOrNull(path.join(src, 'snapshot.json'));
  if (!marker?.isFile()) {
    throw new NotFoundError(`Snapshot '${name}' not found or incomplete (no snapshot.json) at ${src}`);
  }

  return withLocks(RESTORE_LOCKS, async () => {
    const preRestore = await createSnapshot('pre-restore');
    const staging = path.join(getDataDir(), `.restore-${randomUUID()}`);
    try {
      const plan = await stageRestore(name, src, staging);
      try {
        await commitRestore(plan);
      } catch (err: any) {
        throw new Error(
          `Restore of '${name}' failed part-way (${err?.message || err}). The state before the restore ` +
          `is in snapshot '${preRestore.name}': run 'overwatch snapshot restore ${preRestore.name}'.`,
        );
      }
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
    return preRestore;
  });
}

/**
 * Keep the `keep` most recent snapshots, plus up to min(keep, 10) boot
 * snapshots counted on their own. Pre-restore snapshots are never pruned.
 */
export async function pruneOldSnapshots(keep: number = DEFAULT_RETENTION): Promise<number> {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new ValidationError(`Snapshot retention must keep at least 1 snapshot (got ${keep})`);
  }
  // `all` is sorted oldest-first, so the excess of each group is at its start.
  const all = await listSnapshots();
  const excess = (group: SnapshotInfo[], cap: number) => group.slice(0, Math.max(0, group.length - cap));
  const toPrune = [
    ...excess(all.filter(isBootSnapshot), Math.min(keep, BOOT_RETENTION)),
    ...excess(all.filter(s => !isBootSnapshot(s) && !isPreRestoreSnapshot(s)), keep),
  ];
  for (const snap of toPrune) {
    await fs.rm(snapshotDir(snap.name), { recursive: true, force: true });
  }
  return toPrune.length;
}
