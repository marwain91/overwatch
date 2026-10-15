import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { eventBus, type EventMap } from './eventBus';
import { loadConfig, getDataDir } from '../config';
import type { OverwatchConfig } from '../config';
import { sendWebhook } from '../notifications/webhook';
import { NotificationChannel, AlertHistoryEntry } from '../notifications/types';
import { writeSecretFile } from '../utils/security';
import { jsonlLogFor, readLinesReverse } from '../utils/jsonlLog';
import { readJsonStrict } from '../utils/atomicJson';
import { withFileLock } from './fileLock';
import { listApps } from './app';
import { listTenantDirs } from './tenantStore';

type AlertRule = NonNullable<OverwatchConfig['alert_rules']>[number];

interface ActiveAlert {
  ruleId: string;
  scope: string; // e.g. tenantId or containerName
  firedAt: string;
}

const cooldowns = new Map<string, number>(); // ruleId+scope -> lastFiredAt timestamp
const activeAlerts = new Map<string, ActiveAlert>(); // ruleId+scope -> alert info
const containerDownTimers = new Map<string, ReturnType<typeof setTimeout>>(); // ruleId:containerName -> pending down timeout
// A requested stop is not an outage. `docker stop`, `compose stop|down` and
// restarts emit kill, die, stop (then destroy on removal); `docker kill` and
// `rm -f` emit kill, die. A crash emits die alone. `stop` and `destroy` cancel
// the down timer whenever they arrive; a kill only marks the die that follows
// shortly, so an earlier non-fatal signal (a HUP reload) cannot hide a crash.
const KILL_TO_DIE_WINDOW_MS = 30_000;
const stopRequestedAt = new Map<string, number>(); // containerName -> last kill/stop event
// Keyed per rule so two rules of the same type (e.g. 80% warn / 95% critical)
// don't reset each other's timer on every snapshot.
const cpuThresholdTimers = new Map<string, number>(); // ruleId:containerName -> exceededSince timestamp
const memThresholdTimers = new Map<string, number>(); // ruleId:containerName -> exceededSince timestamp

// Containers that vanish (removed, renamed) would otherwise leave per-container
// state behind forever.
const STALE_CONTAINER_MS = 10 * 60 * 1000;
const lastSeen = new Map<string, number>(); // containerName -> last metrics/event/health activity

let started = false;
let unsubscribe: Array<() => void> = [];

function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)([smh]?)$/);
  if (!match) return 300;
  const value = parseInt(match[1], 10);
  const unit = match[2] || 's';
  switch (unit) {
    case 'm': return value * 60 * 1000;
    case 'h': return value * 3600 * 1000;
    default: return value * 1000;
  }
}

function getAlertHistoryFile(): string {
  return path.join(getDataDir(), 'alert-history.jsonl');
}

function getNotificationChannelsFile(): string {
  return path.join(getDataDir(), 'notification-channels.json');
}

// Same serialized writer retention prunes through, so a prune cannot drop an
// alert appended while it runs.
function appendAlertHistory(entry: AlertHistoryEntry): void {
  jsonlLogFor(getAlertHistoryFile(), 'AlertEngine').append(JSON.stringify(entry));
}

/** Missing file is "no channels"; anything unreadable throws so writers cannot clobber it. */
async function readChannelsStrict(): Promise<NotificationChannel[]> {
  try {
    const parsed = await readJsonStrict<unknown>(getNotificationChannelsFile());
    if (!Array.isArray(parsed)) {
      throw new Error(`${path.basename(getNotificationChannelsFile())} is not a JSON array. Refusing to auto-reset.`);
    }
    return parsed as NotificationChannel[];
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

async function loadNotificationChannels(): Promise<NotificationChannel[]> {
  try {
    return await readChannelsStrict();
  } catch (err: any) {
    console.error(`[AlertEngine] Cannot read notification channels: ${err?.message || err}`);
    return [];
  }
}

async function dispatchNotifications(alert: AlertHistoryEntry): Promise<void> {
  const channels = await loadNotificationChannels();
  const enabledChannels = channels.filter(c => c.enabled);

  for (const channel of enabledChannels) {
    if (channel.type === 'webhook') {
      sendWebhook(channel, alert).catch((err) => {
        console.error(`[AlertEngine] Failed to deliver alert to ${channel.name}: ${err?.message || err}`);
      });
    }
  }
}

function checkCooldown(ruleId: string, scope: string, cooldownMs: number): boolean {
  const key = `${ruleId}:${scope}`;
  const lastFired = cooldowns.get(key);
  if (lastFired && Date.now() - lastFired < cooldownMs) {
    return false; // Still in cooldown
  }
  return true;
}

function fireAlert(rule: AlertRule, scope: string, message: string, tenantId?: string, containerName?: string): void {
  const cooldownMs = parseDuration(rule.cooldown);
  const key = `${rule.id}:${scope}`;

  if (!checkCooldown(rule.id, scope, cooldownMs)) return;

  const alert: AlertHistoryEntry = {
    id: randomUUID(),
    ruleId: rule.id,
    ruleName: rule.name,
    severity: rule.severity || 'warning',
    message,
    tenantId,
    containerName,
    firedAt: new Date().toISOString(),
  };

  cooldowns.set(key, Date.now());
  activeAlerts.set(key, {
    ruleId: rule.id,
    scope,
    firedAt: alert.firedAt,
  });

  appendAlertHistory(alert);
  dispatchNotifications(alert);
  eventBus.emit('alert:fired', alert);

  console.log(`[AlertEngine] Alert fired: ${rule.name} — ${message}`);
}

function resolveAlert(rule: AlertRule, scope: string): void {
  const key = `${rule.id}:${scope}`;
  const active = activeAlerts.get(key);
  if (!active) return;

  activeAlerts.delete(key);

  const alert: AlertHistoryEntry = {
    id: randomUUID(),
    ruleId: rule.id,
    ruleName: rule.name,
    severity: 'info',
    message: `Resolved: ${rule.name}`,
    firedAt: active.firedAt,
    resolvedAt: new Date().toISOString(),
  };

  appendAlertHistory(alert);
  dispatchNotifications(alert);
  eventBus.emit('alert:resolved', alert);

  console.log(`[AlertEngine] Alert resolved: ${rule.name}`);
}

function getRules(): AlertRule[] {
  const config = loadConfig();
  return config.alert_rules ?? [];
}

function evictStaleContainers(rules: AlertRule[], now: number): void {
  for (const [name, seenAt] of lastSeen) {
    if (now - seenAt < STALE_CONTAINER_MS) continue;
    for (const rule of rules) {
      const key = `${rule.id}:${name}`;
      resolveAlert(rule, name); // no-op unless an alert is active
      cpuThresholdTimers.delete(key);
      memThresholdTimers.delete(key);
      cooldowns.delete(key);
      activeAlerts.delete(key);
      const down = containerDownTimers.get(key);
      if (down) clearTimeout(down);
      containerDownTimers.delete(key);
    }
    stopRequestedAt.delete(name);
    lastSeen.delete(name);
  }
}

// ─── Backup rules (backup_failed, backup_stale) ──────────────────────────────

const BACKUP_STALE_CHECK_MS = 5 * 60 * 1000;
const DEFAULT_BACKUP_MAX_AGE_HOURS = 26;
// `appId/tenantId` -> time of the last successful backup. A tenant seen for
// the first time starts from its newest snapshot in the repository (so a
// restart does not reset the age), or from now when it has none.
const lastBackupSuccess = new Map<string, number>();
let backupStaleTimer: ReturnType<typeof setInterval> | undefined;

/** Alert scope of a backup; the prefix keeps it apart from container names. */
function backupScope(appId: string, tenantId?: string): string {
  return tenantId ? `backup:${appId}/${tenantId}` : `backup:${appId}`;
}

/** tenantId -> time of its newest snapshot. Best effort: an unreachable repository gives none. */
async function newestSnapshotTimes(appId: string): Promise<Map<string, number>> {
  const newest = new Map<string, number>();
  try {
    // Imported lazily: only backup_stale needs the backup service graph.
    const { listSnapshotsCached } = await import('./backupCache');
    for (const s of await listSnapshotsCached(appId)) {
      const time = Date.parse(s.time);
      if (s.tenantId && Number.isFinite(time)) newest.set(s.tenantId, Math.max(newest.get(s.tenantId) ?? 0, time));
    }
  } catch (err: any) {
    console.error(`[AlertEngine] Backup staleness check could not list the snapshots of '${appId}': ${err?.message || err}`);
  }
  return newest;
}

async function checkBackupStaleness(rules: AlertRule[]): Promise<void> {
  let apps: Awaited<ReturnType<typeof listApps>>;
  try {
    apps = await listApps();
  } catch (err: any) {
    console.error(`[AlertEngine] Backup staleness check could not list apps: ${err?.message || err}`);
    return;
  }

  const current = new Set<string>();
  const unlisted = new Set<string>(); // apps whose tenants could not be listed: keep their state
  for (const app of apps) {
    if (!app.backup?.enabled || !app.backup.schedule) continue;
    let tenantIds: string[];
    try {
      tenantIds = (await listTenantDirs(app.id)).map(t => t.tenantId);
    } catch (err: any) {
      // The scheduled run fails the same way and reports it (backup_failed).
      console.error(`[AlertEngine] Backup staleness check could not list the tenants of '${app.id}': ${err?.message || err}`);
      unlisted.add(app.id);
      continue;
    }
    const newest = tenantIds.some(t => !lastBackupSuccess.has(`${app.id}/${t}`)) ? await newestSnapshotTimes(app.id) : null;
    const now = Date.now();
    for (const tenantId of tenantIds) {
      const key = `${app.id}/${tenantId}`;
      current.add(key);
      if (!lastBackupSuccess.has(key)) lastBackupSuccess.set(key, Math.min(now, newest?.get(tenantId) ?? now));
      const age = now - lastBackupSuccess.get(key)!;
      for (const rule of rules) {
        const maxAgeHours = rule.condition.max_age_hours ?? DEFAULT_BACKUP_MAX_AGE_HOURS;
        if (age > maxAgeHours * 3600 * 1000) {
          fireAlert(rule, backupScope(app.id, tenantId), `No successful backup of ${key} in the last ${maxAgeHours} h`, tenantId);
        }
      }
    }
  }

  // Tenant deleted, or backups of its app disabled: nothing is stale any more.
  for (const key of [...lastBackupSuccess.keys()]) {
    const [appId, tenantId] = key.split('/');
    if (current.has(key) || unlisted.has(appId)) continue;
    for (const rule of rules) resolveAlert(rule, backupScope(appId, tenantId));
    lastBackupSuccess.delete(key);
  }
}

function startBackupRules(
  rules: AlertRule[],
  subscribe: <K extends keyof EventMap>(event: K, handler: (data: EventMap[K]) => void) => void,
): void {
  const failedRules = rules.filter(r => r.condition.type === 'backup_failed');
  const staleRules = rules.filter(r => r.condition.type === 'backup_stale');
  if (failedRules.length === 0 && staleRules.length === 0) return;

  subscribe('backup:failed', (e) => {
    const what = e.tenantId ? `${e.appId}/${e.tenantId}` : `app '${e.appId}'`;
    for (const rule of failedRules) fireAlert(rule, backupScope(e.appId, e.tenantId), `Backup of ${what} failed: ${e.reason}`, e.tenantId);
  });

  subscribe('backup:completed', (e) => {
    if (e.tenantId) {
      // Incomplete backups count: the database is in them (backup_failed reports the rest).
      lastBackupSuccess.set(`${e.appId}/${e.tenantId}`, Date.now());
      for (const rule of staleRules) resolveAlert(rule, backupScope(e.appId, e.tenantId));
    }

    const scope = backupScope(e.appId, e.tenantId);
    for (const rule of failedRules) {
      if (e.incomplete) {
        // The database is in the snapshot, but some files are not: not a backup to rely on.
        fireAlert(rule, scope, `Backup of ${e.appId}/${e.tenantId} is incomplete; not backed up: ${(e.missingPaths ?? []).join(', ')}`, e.tenantId);
        continue;
      }
      resolveAlert(rule, scope);
      // A tenant that was backed up shows the app's runs work again.
      if (e.tenantId) resolveAlert(rule, backupScope(e.appId));
    }
  });

  if (staleRules.length > 0) {
    void checkBackupStaleness(staleRules);
    backupStaleTimer = setInterval(() => { void checkBackupStaleness(staleRules); }, BACKUP_STALE_CHECK_MS);
    backupStaleTimer.unref();
  }
}

function stopBackupRules(): void {
  if (backupStaleTimer) clearInterval(backupStaleTimer);
  backupStaleTimer = undefined;
  lastBackupSuccess.clear();
}

export function startAlertEngine(): void {
  if (started) return;
  started = true;

  const rules = getRules();
  if (rules.length === 0) {
    console.log('[AlertEngine] No alert rules configured');
    return;
  }

  const subscribe = <K extends keyof EventMap>(
    event: K,
    handler: (data: EventMap[K]) => void,
  ) => {
    eventBus.on(event, handler);
    unsubscribe.push(() => eventBus.off(event, handler));
  };

  // Subscribe to metrics for threshold alerts
  subscribe('metrics:snapshot', (data) => {
    const now = Date.now();

    for (const container of data.containers || []) lastSeen.set(container.name, now);
    for (const rule of rules) {
      if (rule.condition.type === 'cpu_threshold') {
        const threshold = rule.condition.threshold || 90;
        const durationMs = parseDuration(rule.condition.duration || '3m');

        for (const container of data.containers || []) {
          const timerKey = `${rule.id}:${container.name}`;
          if (container.cpuPercent > threshold) {
            if (!cpuThresholdTimers.has(timerKey)) {
              cpuThresholdTimers.set(timerKey, now);
            }
            const exceededSince = cpuThresholdTimers.get(timerKey)!;
            if (now - exceededSince >= durationMs) {
              fireAlert(rule, container.name, `CPU ${container.cpuPercent.toFixed(1)}% > ${threshold}% for ${container.name}`, container.tenantId, container.name);
            }
          } else {
            cpuThresholdTimers.delete(timerKey);
            resolveAlert(rule, container.name);
          }
        }
      }

      if (rule.condition.type === 'memory_threshold') {
        const threshold = rule.condition.threshold || 90;
        const durationMs = parseDuration(rule.condition.duration || '3m');

        for (const container of data.containers || []) {
          const timerKey = `${rule.id}:${container.name}`;
          if (container.memPercent > threshold) {
            if (!memThresholdTimers.has(timerKey)) {
              memThresholdTimers.set(timerKey, now);
            }
            const exceededSince = memThresholdTimers.get(timerKey)!;
            if (now - exceededSince >= durationMs) {
              fireAlert(rule, container.name, `Memory ${container.memPercent.toFixed(1)}% > ${threshold}% for ${container.name}`, container.tenantId, container.name);
            }
          } else {
            memThresholdTimers.delete(timerKey);
            resolveAlert(rule, container.name);
          }
        }
      }
    }

  });

  // Existing-but-stopped containers are not "absent": their down alert stays
  // until a start event. Only containers missing from the full listing age out.
  subscribe('containers:existence', (names) => {
    const now = Date.now();
    for (const name of names) lastSeen.set(name, now);
    evictStaleContainers(rules, now);
  });

  // Subscribe to container events for container_down alerts
  const downRules = rules.filter(rule => rule.condition.type === 'container_down');
  const cancelDownTimers = (name: string) => {
    for (const rule of downRules) {
      const key = `${rule.id}:${name}`;
      const timer = containerDownTimers.get(key);
      if (timer) clearTimeout(timer);
      containerDownTimers.delete(key);
    }
  };
  subscribe('container:event', (data) => {
    const name = data.containerName;
    const now = Date.now();
    lastSeen.set(name, now);

    switch (data.action) {
      case 'kill':
      case 'stop':
        stopRequestedAt.set(name, now);
        cancelDownTimers(name); // `stop` follows the `die` of a requested stop
        break;
      case 'destroy':
        // Removed on purpose. A down alert that never fired is simply dropped,
        // so eviction later has nothing to send a "Resolved" for.
        stopRequestedAt.delete(name);
        cancelDownTimers(name);
        break;
      case 'die': {
        const requested = stopRequestedAt.get(name);
        if (requested !== undefined && now - requested < KILL_TO_DIE_WINDOW_MS) break;
        for (const rule of downRules) {
          const key = `${rule.id}:${name}`;
          // Keep the first timer so the down duration counts from when the
          // container actually went down.
          if (containerDownTimers.has(key)) continue;
          const timer = setTimeout(() => {
            if (containerDownTimers.delete(key)) {
              fireAlert(rule, name, `Container ${name} has been down for ${rule.condition.duration || '5m'}`, undefined, name);
            }
          }, parseDuration(rule.condition.duration || '5m'));
          timer.unref();
          containerDownTimers.set(key, timer);
        }
        break;
      }
      case 'start':
        stopRequestedAt.delete(name);
        cancelDownTimers(name);
        for (const rule of downRules) resolveAlert(rule, name);
        break;
    }
  });

  // health_check_failed works off every probe result: `health:change` only
  // reports the transition, whose failure count is always 1, so a threshold
  // above 1 was never reached.
  subscribe('health:probe', (data) => {
    lastSeen.set(data.containerName, Date.now());
    for (const rule of rules) {
      if (rule.condition.type === 'health_check_failed') {
        const maxFailures = rule.condition.consecutive_failures || 3;

        if (data.newState === 'unhealthy' && data.consecutiveFailures >= maxFailures) {
          // Once per outage: the probes that follow must not re-fire it each time the cooldown passes.
          if (activeAlerts.has(`${rule.id}:${data.containerName}`)) continue;
          fireAlert(rule, data.containerName, `Health check failed ${data.consecutiveFailures} times for ${data.containerName}`, data.tenantId, data.containerName);
        } else if (data.newState === 'healthy') {
          resolveAlert(rule, data.containerName);
        }
      }
    }
  });

  startBackupRules(rules, subscribe);

  console.log(`[AlertEngine] Started with ${rules.length} rule(s)`);
}

export function stopAlertEngine(): void {
  started = false;
  for (const off of unsubscribe) off();
  unsubscribe = [];
  for (const timer of containerDownTimers.values()) clearTimeout(timer);
  containerDownTimers.clear();
  stopRequestedAt.clear();
  cooldowns.clear();
  activeAlerts.clear();
  cpuThresholdTimers.clear();
  memThresholdTimers.clear();
  lastSeen.clear();
  stopBackupRules();
}

/** Newest first; reads backwards from the end of the file and stops at `limit`. */
export async function getAlertHistory(limit: number = 50): Promise<AlertHistoryEntry[]> {
  const entries: AlertHistoryEntry[] = [];
  if (limit <= 0) return entries;
  try {
    for await (const line of readLinesReverse(getAlertHistoryFile())) {
      let entry: AlertHistoryEntry | null;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry) continue;
      entries.push(entry);
      if (entries.length >= limit) break;
    }
  } catch {
    // No history yet, or unreadable: same as before, an empty list.
  }
  return entries;
}

export async function getNotificationChannelsData(): Promise<NotificationChannel[]> {
  return loadNotificationChannels();
}

/**
 * Read-modify-write the channel list as one step under the lock, so two
 * concurrent edits cannot both start from the same list and drop each other's
 * change. `mutate` edits the array in place; if it throws, nothing is written.
 */
export async function updateNotificationChannels<T>(mutate: (channels: NotificationChannel[]) => T): Promise<T> {
  const dir = getDataDir();
  await fs.mkdir(dir, { recursive: true });
  return withFileLock('notification-channels', async () => {
    // Throws if the existing file is corrupt: overwriting would destroy the only
    // copy of the admin's channels (and their secrets) for an admin to repair.
    const channels = await readChannelsStrict();
    const result = mutate(channels);
    await writeSecretFile(getNotificationChannelsFile(), JSON.stringify(channels, null, 2));
    return result;
  });
}

export async function saveNotificationChannels(channels: NotificationChannel[]): Promise<void> {
  await updateNotificationChannels((current) => { current.splice(0, current.length, ...channels); });
}

export async function sendTestNotification(channel: NotificationChannel): Promise<void> {
  const testAlert: AlertHistoryEntry = {
    id: 'test-' + randomUUID(),
    ruleId: 'test',
    ruleName: 'Test Notification',
    severity: 'info',
    message: 'This is a test notification from Overwatch',
    firedAt: new Date().toISOString(),
  };
  await sendWebhook(channel, testAlert);
}
