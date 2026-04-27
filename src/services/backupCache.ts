import {
  getBackupInfo,
  listSnapshots,
  type BackupInfo,
  type BackupSnapshot,
  type LockInfo,
} from './backup';

const TTL_MS = 10 * 60 * 1000;

type InfoValue = BackupInfo & { isLocked?: boolean; lockInfo?: LockInfo };
type Entry<T> = { value: T; expires: number };

const infoCache = new Map<string, Entry<InfoValue>>();
const snapshotsCache = new Map<string, Entry<BackupSnapshot[]>>();

const snapKey = (appId: string, tenantId?: string) => `${appId}::${tenantId ?? ''}`;

function getFresh<T>(map: Map<string, Entry<T>>, key: string): T | undefined {
  const hit = map.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    map.delete(key);
    return undefined;
  }
  return hit.value;
}

export async function getBackupInfoCached(appId: string): Promise<InfoValue> {
  const cached = getFresh(infoCache, appId);
  if (cached) return cached;
  const value = await getBackupInfo(appId);
  infoCache.set(appId, { value, expires: Date.now() + TTL_MS });
  return value;
}

export async function listSnapshotsCached(
  appId: string,
  tenantId?: string,
): Promise<BackupSnapshot[]> {
  const key = snapKey(appId, tenantId);
  const cached = getFresh(snapshotsCache, key);
  if (cached) return cached;
  const value = await listSnapshots(appId, tenantId);
  snapshotsCache.set(key, { value, expires: Date.now() + TTL_MS });
  return value;
}

export function invalidateBackupCache(appId: string): void {
  infoCache.delete(appId);
  const prefix = `${appId}::`;
  for (const k of snapshotsCache.keys()) {
    if (k.startsWith(prefix)) snapshotsCache.delete(k);
  }
}
