import * as path from 'path';
import cron, { ScheduledTask } from 'node-cron';
import { loadConfig, getDataDir } from '../config';
import { jsonlLogFor } from '../utils/jsonlLog';
import { pruneAuditLog } from './auditLog';

let scheduledTask: ScheduledTask | null = null;

// Prune through the same serialized writers the appenders use (tmp + rename,
// 0600), so entries appended while a prune runs are never lost.
export async function runRetention(): Promise<void> {
  const config = loadConfig();
  const dataDir = getDataDir();
  const maxAlerts = config.retention?.max_alert_entries ?? 10000;
  const maxAudit = config.retention?.max_audit_entries ?? 10000;

  const alertPruned = await jsonlLogFor(path.join(dataDir, 'alert-history.jsonl'), 'AlertEngine').prune(maxAlerts).catch(() => 0);
  const auditPruned = await pruneAuditLog(maxAudit).catch(() => 0);

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
