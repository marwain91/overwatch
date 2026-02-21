import cron, { ScheduledTask } from 'node-cron';
import { backupAllTenants } from './backup';

let scheduledTask: ScheduledTask | null = null;

export function startBackupScheduler(schedule: string): void {
  if (!cron.validate(schedule)) {
    console.error(`Invalid cron expression: "${schedule}" — scheduler not started`);
    return;
  }

  scheduledTask = cron.schedule(schedule, async () => {
    const startTime = new Date().toISOString();
    console.log(`[Scheduler] Starting scheduled backup at ${startTime}`);

    try {
      const result = await backupAllTenants();
      console.log(
        `[Scheduler] Backup complete — success: ${result.successCount}, failed: ${result.failCount}`
      );
    } catch (error) {
      console.error('[Scheduler] Backup failed with error:', error);
    }
  }, { name: 'backup-all-tenants', noOverlap: true });

  console.log(`Backup scheduler started (schedule: "${schedule}")`);
}

export function stopBackupScheduler(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    console.log('Backup scheduler stopped');
  }
}
