import * as fs from 'fs/promises';
import * as path from 'path';
import { getDataDir } from '../config';

const SNAPSHOT_DIR = '.snapshots';
const FILES_TO_SNAPSHOT = [
  'apps.json',
  'env-vars.json',
  'tenant-env-overrides.json',
  'admin-users.json',
  'audit.log',
  '.schema-versions.json',
];
const DEFAULT_RETENTION = 30;

export interface SnapshotInfo {
  name: string;
  createdAt: string;
  files: string[];
  totalBytes: number;
}

function snapshotsRoot(): string {
  return path.join(getDataDir(), SNAPSHOT_DIR);
}

function isoStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
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
    try {
      const stat = await fs.stat(src);
      if (!stat.isFile()) continue;
      await fs.copyFile(src, path.join(dest, file));
      // Preserve permissions — critical for secret files (0600).
      await fs.chmod(path.join(dest, file), stat.mode & 0o777);
      files.push(file);
      totalBytes += stat.size;
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
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
        out.push(JSON.parse(raw));
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

export async function restoreSnapshot(name: string): Promise<void> {
  const src = path.join(snapshotsRoot(), name);
  try {
    await fs.access(src);
  } catch {
    throw new Error(`Snapshot '${name}' not found at ${src}`);
  }
  const dataDir = getDataDir();
  // Pre-restore: snapshot current state so a bad restore is reversible.
  await createSnapshot('pre-restore');

  for (const file of FILES_TO_SNAPSHOT) {
    const candidate = path.join(src, file);
    try {
      await fs.access(candidate);
    } catch {
      continue;
    }
    const stat = await fs.stat(candidate);
    await fs.copyFile(candidate, path.join(dataDir, file));
    await fs.chmod(path.join(dataDir, file), stat.mode & 0o777);
  }
}

export async function pruneOldSnapshots(keep: number = DEFAULT_RETENTION): Promise<number> {
  const all = await listSnapshots();
  if (all.length <= keep) return 0;
  // `all` is sorted oldest-first, so excess to prune is at the start.
  const toPrune = all.slice(0, all.length - keep);
  let pruned = 0;
  for (const snap of toPrune) {
    // Never prune a pre-restore snapshot automatically — operator may still need it.
    if (snap.name.endsWith('_pre-restore')) continue;
    await fs.rm(path.join(snapshotsRoot(), snap.name), { recursive: true, force: true });
    pruned++;
  }
  return pruned;
}
