import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const tasks: Array<{ expr: string; fn: () => void; stop: ReturnType<typeof vi.fn> }> = [];
vi.mock('node-cron', () => ({
  default: {
    validate: (e: string) => e !== 'bad',
    schedule: vi.fn((expr: string, fn: () => void) => {
      const t = { expr, fn, stop: vi.fn() };
      tasks.push(t);
      return t;
    }),
  },
}));

let apps: any[] = [];
let listAppsImpl: () => Promise<any[]> = async () => apps;
vi.mock('../services/app', () => ({ listApps: () => listAppsImpl() }));
vi.mock('../services/backup', () => ({ backupAllTenants: vi.fn() }));

import {
  reconcileBackupSchedulers, stopBackupScheduler, startAllBackupSchedulers,
  startSchedulerReconciler, stopSchedulerReconciler,
} from '../services/scheduler';

const app = (id: string, schedule?: string, enabled = true) => ({
  id, backup: schedule ? { enabled, schedule } : undefined,
});
const live = () => tasks.filter(t => !t.stop.mock.calls.length);

beforeEach(async () => {
  stopBackupScheduler();
  stopSchedulerReconciler();
  tasks.length = 0;
  apps = [];
  listAppsImpl = async () => apps;
  await startAllBackupSchedulers(); // re-arm after the stop above (no apps: schedules nothing)
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reconcileBackupSchedulers', () => {
  it('schedules a newly created app with backups', async () => {
    apps = [app('a', '0 2 * * *')];
    await reconcileBackupSchedulers();
    expect(live().map(t => t.expr)).toEqual(['0 2 * * *']);
  });

  it('is idempotent', async () => {
    apps = [app('a', '0 2 * * *')];
    await reconcileBackupSchedulers();
    await reconcileBackupSchedulers();
    expect(tasks).toHaveLength(1);
  });

  it('restarts when the schedule changes', async () => {
    apps = [app('a', '0 2 * * *')];
    await reconcileBackupSchedulers();
    apps = [app('a', '0 3 * * *')];
    await reconcileBackupSchedulers();
    expect(tasks[0].stop).toHaveBeenCalled();
    expect(live().map(t => t.expr)).toEqual(['0 3 * * *']);
  });

  it('stops a deleted app and a disabled one', async () => {
    apps = [app('a', '0 2 * * *'), app('b', '0 4 * * *')];
    await reconcileBackupSchedulers();
    apps = [app('b', '0 4 * * *', false)];
    await reconcileBackupSchedulers();
    expect(live()).toHaveLength(0);
  });

  it('stops the old task when the new schedule is invalid, and reports it once', async () => {
    apps = [app('a', '0 2 * * *')];
    await reconcileBackupSchedulers();
    apps = [app('a', 'bad')];
    await reconcileBackupSchedulers();
    await reconcileBackupSchedulers();
    expect(live()).toHaveLength(0);
    expect((console.error as any).mock.calls.filter((c: any[]) => String(c[0]).includes('Invalid cron'))).toHaveLength(1);
  });
});

describe('reconcile after stopBackupScheduler', () => {
  it('a reconcile queued after the stop is a no-op', async () => {
    apps = [app('a', '0 2 * * *')];
    stopBackupScheduler();
    await reconcileBackupSchedulers();
    expect(tasks).toHaveLength(0);
  });

  it('a reconcile already waiting on the app list when the stop happens starts nothing', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    apps = [app('a', '0 2 * * *')];
    listAppsImpl = async () => { await gate; return apps; };
    const pending = reconcileBackupSchedulers();
    stopBackupScheduler();
    release();
    await pending;
    expect(live()).toHaveLength(0);
  });

  it('startAllBackupSchedulers re-arms reconciling', async () => {
    stopBackupScheduler();
    apps = [app('a', '0 2 * * *')];
    await startAllBackupSchedulers();
    await reconcileBackupSchedulers();
    expect(live().map(t => t.expr)).toEqual(['0 2 * * *']);
  });
});

describe('overlapping reconciles', () => {
  it('are serialised: two concurrent triggers schedule the task once', async () => {
    apps = [app('a', '0 2 * * *')];
    await Promise.all([reconcileBackupSchedulers(), reconcileBackupSchedulers(), reconcileBackupSchedulers()]);
    expect(tasks).toHaveLength(1);
  });

  it('a failing reconcile does not break the chain for the next one', async () => {
    listAppsImpl = async () => { throw new Error('disk gone'); };
    await expect(reconcileBackupSchedulers()).rejects.toThrow('disk gone');
    listAppsImpl = async () => apps;
    apps = [app('a', '0 2 * * *')];
    await reconcileBackupSchedulers();
    expect(live()).toHaveLength(1);
  });
});

describe('start/stopSchedulerReconciler', () => {
  const reconcileTasks = () => tasks.filter(t => t.expr === '* * * * *');

  it('start is idempotent, runs a reconcile on each tick, and stop stops the task', async () => {
    apps = [app('a', '0 2 * * *')];
    startSchedulerReconciler();
    startSchedulerReconciler();
    expect(reconcileTasks()).toHaveLength(1);

    reconcileTasks()[0].fn();
    await vi.waitFor(() => expect(live().some(t => t.expr === '0 2 * * *')).toBe(true));

    stopSchedulerReconciler();
    expect(reconcileTasks()[0].stop).toHaveBeenCalledTimes(1);
    startSchedulerReconciler();
    expect(reconcileTasks()).toHaveLength(2);
  });

  it('a tick whose reconcile fails logs instead of throwing', async () => {
    listAppsImpl = async () => { throw new Error('tick boom'); };
    startSchedulerReconciler();
    reconcileTasks()[0].fn();
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith('[Scheduler] reconcile failed:', 'tick boom'));
  });
});
