import * as fs from 'fs/promises';
import * as path from 'path';
import cron, { ScheduledTask } from 'node-cron';
import { loadConfig, getDataDir } from '../config';

let scheduledTask: ScheduledTask | null = null;

async function pruneJsonlFile(filePath: string, maxEntries: number): Promise<number> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }

  const lines = content.trim().split('\n').filter(Boolean);
  if (lines.length <= maxEntries) return 0;

  const pruned = lines.length - maxEntries;
  const kept = lines.slice(-maxEntries);
  await fs.writeFile(filePath, kept.join('\n') + '\n');
  return pruned;
}

async function runRetention(): Promise<void> {
  const config = loadConfig();
  const dataDir = getDataDir();
  const maxAlerts = config.retention?.max_alert_entries ?? 10000;
  const maxAudit = config.retention?.max_audit_entries ?? 10000;

  const alertFile = path.join(dataDir, 'alert-history.jsonl');
  const auditFile = path.join(dataDir, 'audit.log');

  const alertPruned = await pruneJsonlFile(alertFile, maxAlerts).catch(() => 0);
  const auditPruned = await pruneJsonlFile(auditFile, maxAudit).catch(() => 0);

  if (alertPruned > 0 || auditPruned > 0) {
    console.log(`[Retention] Pruned ${alertPruned} alert(s), ${auditPruned} audit log(s)`);
  }
}

export function startRetention(): void {
  // Prune immediately on startup
  runRetention().catch((err) => console.error('[Retention] Error:', err.message));

  // Then prune every hour
  scheduledTask = cron.schedule('0 * * * *', () => {
    runRetention().catch((err) => console.error('[Retention] Error:', err.message));
  }, { name: 'retention-pruner' });

  console.log('[Retention] Started (interval: hourly)');
}

export function stopRetention(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
}
