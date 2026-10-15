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

    const { eventBus } = await import('../services/eventBus');
    const snapshots: any[] = [];
    const existence: string[][] = [];
    eventBus.on('metrics:snapshot', (d) => snapshots.push(d));
    eventBus.on('containers:existence', (d) => existence.push(d));
    const mod = await import('../services/metricsCollector');
    mod.startMetricsCollector(15);
    await vi.advanceTimersByTimeAsync(0);
    expect(mod.getMetricsHistory('app-t1-web')).toHaveLength(1);

    // The snapshot is relayed to every WebSocket client: no host-wide container list on it.
    expect(snapshots.length).toBeGreaterThan(0);
    for (const snap of snapshots) expect(snap).not.toHaveProperty('existingNames');
    expect(existence.at(-1)).toContain('app-t1-web');

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

describe('metrics collector stats fan-out', () => {
  const labelled = (i: number) => ({
    Id: `c${String(i).padStart(2, '0')}`.padEnd(64, '0'),
    Names: [`/app-t${i}-web`],
    Labels: { 'com.overwatch.managed': 'true', 'com.overwatch.app-id': 'app', 'com.overwatch.tenant-id': `t${i}`, 'com.overwatch.service': 'web' },
  });

  async function load(running: any[], stats: (id: string, opts: any) => Promise<unknown>) {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.doMock('node-cron', () => ({
      default: { validate: () => true, schedule: (_e: string, fn: () => void) => { (globalThis as any).__tick = fn; return { stop: () => {} }; } },
    }));
    vi.doMock('../services/docker', async () => ({
      ...(await vi.importActual<typeof import('../services/docker')>('../services/docker')),
      docker: {
        listContainers: async () => running,
        getContainer: (id: string) => ({ stats: (opts: any) => stats(id, opts) }),
      },
    }));
    vi.doMock('../services/app', () => ({ listApps: async () => [{ id: 'app', services: [] }] }));
    const { eventBus } = await import('../services/eventBus');
    const snapshots: any[] = [];
    eventBus.on('metrics:snapshot', (d) => snapshots.push(d));
    const mod = await import('../services/metricsCollector');
    return { mod, snapshots };
  }

  it('caps concurrent stats calls instead of firing one per container at once', async () => {
    const running = Array.from({ length: 30 }, (_, i) => labelled(i));
    let inFlight = 0;
    let peak = 0;
    const { mod, snapshots } = await load(running, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return stats;
    });
    mod.startMetricsCollector(15);
    await vi.waitFor(() => expect(snapshots).toHaveLength(1), { timeout: 4000 });
    mod.stopMetricsCollector();
    expect(snapshots[0].containers).toHaveLength(30);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(10);
  });

  it('abandons and aborts a hung stats call so one container cannot freeze collection', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const { mod, snapshots } = await load([labelled(1), labelled(2)], (id, opts) => {
      signals.push(opts?.abortSignal);
      if (id.startsWith('c01')) return new Promise(() => {}); // dockerd never answers
      return Promise.resolve(stats);
    });
    mod.startMetricsCollector(15);
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].containers.map((c: any) => c.name)).toEqual(['app-t2-web']);
    expect(signals).toHaveLength(2);
    expect(signals.every(s => s instanceof AbortSignal)).toBe(true);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);

    // The next tick runs normally instead of being skipped as still "collecting".
    const next = (globalThis as any).__tick();
    await vi.advanceTimersByTimeAsync(10_000);
    await next;
    expect(snapshots).toHaveLength(2);
    mod.stopMetricsCollector();
  });
});
