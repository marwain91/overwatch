import cron, { ScheduledTask } from 'node-cron';
import * as path from 'path';
import * as fs from 'fs/promises';
import { backupAllTenants } from './backup';
import { listApps } from './app';
import { getDataDir } from '../config';
import { writeJsonAtomic, readJsonStrict } from '../utils/atomicJson';

const scheduledTasks = new Map<string, ScheduledTask>();

interface InFlightRun {
  appId: string;
  startedAt: string;
  pid: number;
}
interface SchedulerState {
  inFlight: InFlightRun[];
}

function stateFile(): string {
  return path.join(getDataDir(), '.scheduler-state.json');
}

async function loadState(): Promise<SchedulerState> {
  try {
    return await readJsonStrict<SchedulerState>(stateFile());
  } catch (err: any) {
    if (err.code === 'ENOENT') return { inFlight: [] };
    // Malformed state file is non-fatal — log and start clean. Scheduler state is
    // best-effort breadcrumbs, not a source of truth.
    console.error(`[Scheduler] state file unreadable: ${err.message}. Starting clean.`);
    return { inFlight: [] };
  }
}

async function saveState(s: SchedulerState): Promise<void> {
  try {
    await writeJsonAtomic(stateFile(), s, { mode: 0o600 });
  } catch (err: any) {
    console.error(`[Scheduler] failed to persist state: ${err.message}`);
  }
}

async function markStart(appId: string): Promise<void> {
  const s = await loadState();
  s.inFlight = s.inFlight.filter(r => r.appId !== appId);
  s.inFlight.push({ appId, startedAt: new Date().toISOString(), pid: process.pid });
  await saveState(s);
}

async function markEnd(appId: string): Promise<void> {
  const s = await loadState();
  s.inFlight = s.inFlight.filter(r => r.appId !== appId);
  await saveState(s);
}

/** On boot, report (don't automatically resume) any runs that were in-flight when
 * the previous process died. Operator can investigate and re-run manually. */
export async function reportAbandonedRuns(): Promise<void> {
  const s = await loadState();
  if (s.inFlight.length === 0) return;
  for (const run of s.inFlight) {
    console.error(
      `[Scheduler] previous run for app '${run.appId}' (pid ${run.pid}, started ${run.startedAt}) ` +
      `did not finish cleanly. Not auto-resuming — check backup state and re-run if needed.`
    );
  }
  // Clear the stale entries so they don't alarm on every boot.
  await saveState({ inFlight: [] });
}

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

    await markStart(appId);
    try {
      const result = await backupAllTenants(appId);
      console.log(
        `[Scheduler] Backup for app '${appId}' complete — success: ${result.successCount}, failed: ${result.failCount}`
      );
    } catch (error) {
      console.error(`[Scheduler] Backup for app '${appId}' failed with error:`, error);
    } finally {
      await markEnd(appId);
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
