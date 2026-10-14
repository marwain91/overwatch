/**
 * Registry of the single files Overwatch keeps directly under `data/`.
 * Each consumer derives its list from the flags here, so a new data file is
 * registered once instead of being added to three hand-kept lists.
 */
export interface DataFileSpec {
  name: string;
  /** Holds secrets: startup tightens it to 0600. */
  secret?: boolean;
  /** Included in config snapshots. */
  snapshot?: boolean;
  /** Used to be a single-file bind mount; an empty directory in its place is repaired at startup. */
  bindRepair?: boolean;
}

export const DATA_FILES: readonly DataFileSpec[] = [
  { name: 'apps.runtime.json', snapshot: true },
  { name: 'apps.trashed.json', snapshot: true },
  { name: 'env-vars.json', secret: true, snapshot: true, bindRepair: true },
  { name: 'tenant-env-overrides.json', secret: true, snapshot: true, bindRepair: true },
  { name: 'admin-users.json', snapshot: true, bindRepair: true },
  { name: 'audit.log', snapshot: true, bindRepair: true },
  { name: '.schema-versions.json', snapshot: true },
  { name: 'alert-history.jsonl', bindRepair: true },
  { name: 'notification-channels.json', secret: true, snapshot: true, bindRepair: true },
  { name: 'mcp-oauth.json', snapshot: true },
];

type DataFileFlag = 'secret' | 'snapshot' | 'bindRepair';

function namesWith(flag: DataFileFlag): string[] {
  return DATA_FILES.filter(f => f[flag]).map(f => f.name);
}

export const secretDataFiles = (): string[] => namesWith('secret');
export const snapshotDataFiles = (): string[] => namesWith('snapshot');
export const bindRepairDataFiles = (): string[] => namesWith('bindRepair');
