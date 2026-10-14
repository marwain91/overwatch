import cron, { ScheduledTask } from 'node-cron';
import * as path from 'path';
import { backupAllTenants } from './backup';
import { listApps } from './app';
import { getDataDir } from '../config';
import { writeJsonAtomic, readJsonStrict } from '../utils/atomicJson';

interface ScheduledEntry {
  task: ScheduledTask;
  schedule: string;
}
const scheduledTasks = new Map<string, ScheduledEntry>();
const warnedInvalid = new Set<string>();

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

  scheduledTasks.set(appId, { task, schedule });
  console.log(`Backup scheduler started for app '${appId}' (schedule: "${schedule}")`);
}

/**
 * Stop the backup scheduler for a specific app, or all of them.
 */
export function stopBackupScheduler(appId?: string): void {
  if (appId) {
    const entry = scheduledTasks.get(appId);
    if (entry) {
      entry.task.stop();
      scheduledTasks.delete(appId);
      console.log(`Backup scheduler stopped for app '${appId}'`);
    }
    return;
  }
  for (const entry of scheduledTasks.values()) {
    entry.task.stop();
  }
  scheduledTasks.clear();
  console.log('All backup schedulers stopped');
}

let reconcileChain: Promise<void> = Promise.resolve();

/**
 * Make running backup tasks match the current app definitions: start new,
 * stop removed/disabled, restart when the schedule changed. Idempotent.
 * Calls are serialized so overlapping triggers can't act on stale app lists.
 */
export function reconcileBackupSchedulers(): Promise<void> {
  const run = reconcileChain.then(doReconcile, doReconcile);
  reconcileChain = run.catch(() => {});
  return run;
}

async function doReconcile(): Promise<void> {
  const apps = await listApps();
  const desired = new Map<string, string>();
  for (const app of apps) {
    if (app.backup?.enabled && app.backup?.schedule) desired.set(app.id, app.backup.schedule);
  }

  for (const id of [...scheduledTasks.keys()]) {
    if (!desired.has(id)) stopBackupScheduler(id);
  }

  for (const [id, schedule] of desired) {
    const running = scheduledTasks.get(id);
    if (running?.schedule === schedule) continue;
    if (running) stopBackupScheduler(id);
    if (!cron.validate(schedule)) {
      // Reconcile runs every minute; report each bad schedule once.
      const key = `${id}\0${schedule}`;
      if (!warnedInvalid.has(key)) {
        warnedInvalid.add(key);
        startBackupScheduler(id, schedule); // logs the invalid-expression error
      }
      continue;
    }
    startBackupScheduler(id, schedule);
  }
}

let reconcileTask: ScheduledTask | undefined;

/** Re-reconcile every minute: CLI edits to apps.d bypass the server's mutation hooks. */
export function startSchedulerReconciler(): void {
  if (reconcileTask) return;
  reconcileTask = cron.schedule('* * * * *', () => {
    reconcileBackupSchedulers().catch(err =>
      console.error('[Scheduler] reconcile failed:', err?.message ?? err));
  }, { name: 'backup-reconcile', noOverlap: true });
}

export function stopSchedulerReconciler(): void {
  reconcileTask?.stop();
  reconcileTask = undefined;
}
