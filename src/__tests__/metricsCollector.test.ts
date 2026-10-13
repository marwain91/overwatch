import { describe, it, expect, afterEach, vi } from 'vitest';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('node-cron');
  vi.doUnmock('../services/docker');
  vi.doUnmock('../services/app');
});

const stats = {
  cpu_stats: { cpu_usage: { total_usage: 2 }, system_cpu_usage: 2, online_cpus: 1 },
  precpu_stats: { cpu_usage: { total_usage: 1 }, system_cpu_usage: 1 },
  memory_stats: { usage: 10, limit: 100 },
};

describe('metrics collector retention', () => {
  it('drops history only for containers that no longer exist, 10 minutes after last sample', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    let stopped: any[] = [];
    let running = [{ Id: 'aaaaaaaaaaaa1', Names: ['/app-t1-web'], Labels: { 'com.overwatch.managed': 'true', 'com.overwatch.app-id': 'app', 'com.overwatch.tenant-id': 't1', 'com.overwatch.service': 'web' } }];
    vi.doMock('node-cron', () => ({
      default: { validate: () => true, schedule: (_e: string, fn: () => void) => { (globalThis as any).__tick = fn; return { stop: () => {} }; } },
    }));
    vi.doMock('../services/docker', async () => ({
      ...(await vi.importActual<typeof import('../services/docker')>('../services/docker')),
      docker: {
        listContainers: async (o: any) => (o?.all ? [...running, ...stopped] : running),
        getContainer: () => ({ stats: async () => stats }),
      },
    }));
    vi.doMock('../services/app', () => ({ listApps: async () => [{ id: 'app', services: [] }] }));

    const mod = await import('../services/metricsCollector');
    mod.startMetricsCollector(15);
    await vi.advanceTimersByTimeAsync(0);
    expect(mod.getMetricsHistory('app-t1-web')).toHaveLength(1);

    stopped = [{ Id: 'aaaaaaaaaaaa1', Names: ['/app-t1-web'] }];
    running = [];
    vi.setSystemTime(new Date('2026-01-01T00:09:00Z'));
    await (globalThis as any).__tick();
    expect(mod.getMetricsHistory('app-t1-web')).toHaveLength(1);
    expect(mod.getMetrics().containers).toHaveLength(1);

    vi.setSystemTime(new Date('2026-01-01T00:10:01Z'));
    await (globalThis as any).__tick();
    expect(mod.getMetricsHistory('app-t1-web')).toHaveLength(1); // stopped but still exists

    stopped = [];
    await (globalThis as any).__tick();
    expect(mod.getMetricsHistory('app-t1-web')).toHaveLength(0);
    expect(mod.getMetrics().containers).toHaveLength(0);
    mod.stopMetricsCollector();
  });
});
