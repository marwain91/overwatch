import { describe, it, expect, beforeEach, vi } from 'vitest';

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
vi.mock('../services/app', () => ({ listApps: async () => apps }));
vi.mock('../services/backup', () => ({ backupAllTenants: vi.fn() }));

import { reconcileBackupSchedulers, stopBackupScheduler } from '../services/scheduler';

const app = (id: string, schedule?: string, enabled = true) => ({
  id, backup: schedule ? { enabled, schedule } : undefined,
});
const live = () => tasks.filter(t => !t.stop.mock.calls.length);

beforeEach(() => {
  stopBackupScheduler();
  tasks.length = 0;
  apps = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
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
