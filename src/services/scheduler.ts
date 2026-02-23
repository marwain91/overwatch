import cron, { ScheduledTask } from 'node-cron';
import { backupAllTenants } from './backup';
import { listApps } from './app';

const scheduledTasks = new Map<string, ScheduledTask>();

/**
 * Start backup schedulers for all apps that have backup schedules configured.
 */
export async function startAllBackupSchedulers(): Promise<void> {
  const apps = await listApps();

  for (const app of apps) {
    if (app.backup?.enabled && app.backup?.schedule) {
      startBackupScheduler(app.id, app.backup.schedule);
    }
  }
}

/**
 * Start a backup scheduler for a specific app.
 */
export function startBackupScheduler(appId: string, schedule: string): void {
  if (!cron.validate(schedule)) {
    console.error(`Invalid cron expression for app '${appId}': "${schedule}" — scheduler not started`);
    return;
  }

  // Stop existing scheduler for this app if any
  stopBackupScheduler(appId);

  const task = cron.schedule(schedule, async () => {
    const startTime = new Date().toISOString();
    console.log(`[Scheduler] Starting scheduled backup for app '${appId}' at ${startTime}`);

    try {
      const result = await backupAllTenants(appId);
      console.log(
        `[Scheduler] Backup for app '${appId}' complete — success: ${result.successCount}, failed: ${result.failCount}`
      );
    } catch (error) {
      console.error(`[Scheduler] Backup for app '${appId}' failed with error:`, error);
    }
  }, { name: `backup-${appId}`, noOverlap: true });

  scheduledTasks.set(appId, task);
  console.log(`Backup scheduler started for app '${appId}' (schedule: "${schedule}")`);
}

/**
 * Stop the backup scheduler for a specific app.
 */
export function stopBackupScheduler(appId?: string): void {
  if (appId) {
    const task = scheduledTasks.get(appId);
    if (task) {
      task.stop();
      scheduledTasks.delete(appId);
      console.log(`Backup scheduler stopped for app '${appId}'`);
    }
  } else {
    // Stop all schedulers
    for (const [id, task] of scheduledTasks) {
      task.stop();
    }
    scheduledTasks.clear();
    if (scheduledTasks.size === 0) {
      console.log('All backup schedulers stopped');
    }
  }
}
