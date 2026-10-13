import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { eventBus } from './eventBus';
import { loadConfig, getDataDir } from '../config';
import type { OverwatchConfig } from '../config';
import { sendWebhook } from '../notifications/webhook';
import { NotificationChannel, AlertHistoryEntry } from '../notifications/types';
import { writeSecretFile } from '../utils/security';
import { readJsonStrict } from '../utils/atomicJson';

type AlertRule = NonNullable<OverwatchConfig['alert_rules']>[number];

interface ActiveAlert {
  ruleId: string;
  scope: string; // e.g. tenantId or containerName
  firedAt: string;
}

const cooldowns = new Map<string, number>(); // ruleId+scope -> lastFiredAt timestamp
const activeAlerts = new Map<string, ActiveAlert>(); // ruleId+scope -> alert info
const containerDownTimers = new Map<string, ReturnType<typeof setTimeout>>(); // ruleId:containerName -> pending down timeout
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

async function appendAlertHistory(entry: AlertHistoryEntry): Promise<void> {
  const line = JSON.stringify(entry);
  await fs.appendFile(getAlertHistoryFile(), line + '\n', { mode: 0o600 }).catch((err) => {
    console.error(`[AlertEngine] Failed to append alert history: ${err?.message || err}`);
  });
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
    lastSeen.delete(name);
  }
}

export function startAlertEngine(): void {
  if (started) return;
  started = true;

  const rules = getRules();
  if (rules.length === 0) {
    console.log('[AlertEngine] No alert rules configured');
    return;
  }

  const subscribe = (event: string, handler: (data: any) => void) => {
    eventBus.on(event, handler);
    unsubscribe.push(() => eventBus.off(event, handler));
  };

  // Subscribe to metrics for threshold alerts
  subscribe('metrics:snapshot', (data: any) => {
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
  subscribe('containers:existence', (names: string[]) => {
    const now = Date.now();
    for (const name of names) lastSeen.set(name, now);
    evictStaleContainers(rules, now);
  });

  // Subscribe to container events for container_down alerts
  subscribe('container:event', (data: any) => {
    lastSeen.set(data.containerName, Date.now());
    for (const rule of rules) {
      if (rule.condition.type === 'container_down') {
        const durationMs = parseDuration(rule.condition.duration || '5m');
        const key = `${rule.id}:${data.containerName}`;

        if (data.action === 'die' || data.action === 'stop') {
          // die + stop both arrive for one outage: keep the first timer so the
          // down duration counts from when the container actually went down.
          if (containerDownTimers.has(key)) continue;
          const timer = setTimeout(() => {
            if (containerDownTimers.delete(key)) {
              fireAlert(rule, data.containerName, `Container ${data.containerName} has been down for ${rule.condition.duration || '5m'}`, undefined, data.containerName);
            }
          }, durationMs);
          timer.unref();
          containerDownTimers.set(key, timer);
        } else if (data.action === 'start') {
          const timer = containerDownTimers.get(key);
          if (timer) clearTimeout(timer);
          containerDownTimers.delete(key);
          resolveAlert(rule, data.containerName);
        }
      }
    }
  });

  // Subscribe to health changes for health_check_failed alerts
  subscribe('health:change', (data: any) => {
    // 'unknown' is the health checker evicting the container; don't resurrect its state.
    if (data.newState !== 'unknown') lastSeen.set(data.containerName, Date.now());
    for (const rule of rules) {
      if (rule.condition.type === 'health_check_failed') {
        const maxFailures = rule.condition.consecutive_failures || 3;

        if (data.newState === 'unhealthy' && data.consecutiveFailures >= maxFailures) {
          fireAlert(rule, data.containerName, `Health check failed ${data.consecutiveFailures} times for ${data.containerName}`, data.tenantId, data.containerName);
        } else if (data.newState === 'healthy') {
          resolveAlert(rule, data.containerName);
        }
      }
    }
  });

  console.log(`[AlertEngine] Started with ${rules.length} rule(s)`);
}

export function stopAlertEngine(): void {
  started = false;
  for (const off of unsubscribe) off();
  unsubscribe = [];
  for (const timer of containerDownTimers.values()) clearTimeout(timer);
  containerDownTimers.clear();
  cooldowns.clear();
  activeAlerts.clear();
  cpuThresholdTimers.clear();
  memThresholdTimers.clear();
  lastSeen.clear();
}

export async function getAlertHistory(limit: number = 50): Promise<AlertHistoryEntry[]> {
  try {
    const content = await fs.readFile(getAlertHistoryFile(), 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const entries = lines
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean) as AlertHistoryEntry[];
    return entries.slice(-limit).reverse();
  } catch {
    return [];
  }
}

export async function getNotificationChannelsData(): Promise<NotificationChannel[]> {
  return loadNotificationChannels();
}

export async function saveNotificationChannels(channels: NotificationChannel[]): Promise<void> {
  const dir = getDataDir();
  await fs.mkdir(dir, { recursive: true });
  // Throws if the existing file is corrupt: overwriting would destroy the only
  // copy of the admin's channels (and their secrets) for an admin to repair.
  await readChannelsStrict();
  await writeSecretFile(getNotificationChannelsFile(), JSON.stringify(channels, null, 2));
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
