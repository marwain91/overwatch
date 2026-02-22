import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { eventBus } from './eventBus';
import { loadConfig, getDataDir } from '../config';
import { sendWebhook } from '../notifications/webhook';
import { NotificationChannel, AlertHistoryEntry } from '../notifications/types';

interface AlertRule {
  id: string;
  name: string;
  condition: {
    type: 'container_down' | 'cpu_threshold' | 'memory_threshold' | 'health_check_failed';
    duration?: string;
    threshold?: number;
    consecutive_failures?: number;
  };
  cooldown: string;
  severity?: string;
}

interface ActiveAlert {
  ruleId: string;
  scope: string; // e.g. tenantId or containerName
  firedAt: string;
}

const cooldowns = new Map<string, number>(); // ruleId+scope -> lastFiredAt timestamp
const activeAlerts = new Map<string, ActiveAlert>(); // ruleId+scope -> alert info
const containerDownTimers = new Map<string, number>(); // containerName -> downSince timestamp
const cpuThresholdTimers = new Map<string, number>(); // containerName -> exceededSince timestamp
const memThresholdTimers = new Map<string, number>(); // containerName -> exceededSince timestamp

let started = false;

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
  await fs.appendFile(getAlertHistoryFile(), line + '\n').catch(() => {});
}

async function loadNotificationChannels(): Promise<NotificationChannel[]> {
  try {
    const content = await fs.readFile(getNotificationChannelsFile(), 'utf-8');
    return JSON.parse(content);
  } catch {
    return [];
  }
}

async function dispatchNotifications(alert: AlertHistoryEntry): Promise<void> {
  const channels = await loadNotificationChannels();
  const enabledChannels = channels.filter(c => c.enabled);

  for (const channel of enabledChannels) {
    if (channel.type === 'webhook') {
      sendWebhook(channel, alert).catch(() => {});
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
  return (config as any).alert_rules || [];
}

export function startAlertEngine(): void {
  if (started) return;
  started = true;

  const rules = getRules();
  if (rules.length === 0) {
    console.log('[AlertEngine] No alert rules configured');
    return;
  }

  // Subscribe to metrics for threshold alerts
  eventBus.on('metrics:snapshot', (data: any) => {
    const now = Date.now();

    for (const rule of rules) {
      if (rule.condition.type === 'cpu_threshold') {
        const threshold = rule.condition.threshold || 90;
        const durationMs = parseDuration(rule.condition.duration || '3m');

        for (const container of data.containers || []) {
          if (container.cpuPercent > threshold) {
            if (!cpuThresholdTimers.has(container.name)) {
              cpuThresholdTimers.set(container.name, now);
            }
            const exceededSince = cpuThresholdTimers.get(container.name)!;
            if (now - exceededSince >= durationMs) {
              fireAlert(rule, container.name, `CPU ${container.cpuPercent.toFixed(1)}% > ${threshold}% for ${container.name}`, container.tenantId, container.name);
            }
          } else {
            cpuThresholdTimers.delete(container.name);
            resolveAlert(rule, container.name);
          }
        }
      }

      if (rule.condition.type === 'memory_threshold') {
        const threshold = rule.condition.threshold || 90;
        const durationMs = parseDuration(rule.condition.duration || '3m');

        for (const container of data.containers || []) {
          if (container.memPercent > threshold) {
            if (!memThresholdTimers.has(container.name)) {
              memThresholdTimers.set(container.name, now);
            }
            const exceededSince = memThresholdTimers.get(container.name)!;
            if (now - exceededSince >= durationMs) {
              fireAlert(rule, container.name, `Memory ${container.memPercent.toFixed(1)}% > ${threshold}% for ${container.name}`, container.tenantId, container.name);
            }
          } else {
            memThresholdTimers.delete(container.name);
            resolveAlert(rule, container.name);
          }
        }
      }
    }
  });

  // Subscribe to container events for container_down alerts
  eventBus.on('container:event', (data: any) => {
    for (const rule of rules) {
      if (rule.condition.type === 'container_down') {
        const durationMs = parseDuration(rule.condition.duration || '5m');

        if (data.action === 'die' || data.action === 'stop') {
          containerDownTimers.set(data.containerName, Date.now());
          setTimeout(() => {
            if (containerDownTimers.has(data.containerName)) {
              fireAlert(rule, data.containerName, `Container ${data.containerName} has been down for ${rule.condition.duration || '5m'}`, undefined, data.containerName);
            }
          }, durationMs);
        } else if (data.action === 'start') {
          containerDownTimers.delete(data.containerName);
          resolveAlert(rule, data.containerName);
        }
      }
    }
  });

  // Subscribe to health changes for health_check_failed alerts
  eventBus.on('health:change', (data: any) => {
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
  cooldowns.clear();
  activeAlerts.clear();
  containerDownTimers.clear();
  cpuThresholdTimers.clear();
  memThresholdTimers.clear();
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
  await fs.writeFile(getNotificationChannelsFile(), JSON.stringify(channels, null, 2));
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
