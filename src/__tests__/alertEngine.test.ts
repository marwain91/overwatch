import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import { containerEvent, metricsSnapshot } from './eventFixtures';

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-alert-engine-'));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  // History appends are queued; let them land before the directory goes away.
  const { jsonlLogFor } = await import('../utils/jsonlLog');
  await jsonlLogFor(path.join(dataDir, 'alert-history.jsonl')).flush();
  vi.resetModules();
  vi.doUnmock('../config');
  vi.doUnmock('../notifications/webhook');
  await fs.rm(dataDir, { recursive: true, force: true });
});

function cpuRule(id: string, threshold: number) {
  return {
    id,
    name: `CPU > ${threshold}%`,
    condition: { type: 'cpu_threshold', threshold, duration: '1s' },
    cooldown: '15m',
    severity: 'warning',
  };
}

describe('alert engine threshold timers', () => {
  it('keeps a separate timer per rule so a stricter rule cannot reset a looser one', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.doMock('../config', () => ({
      loadConfig: () => ({ alert_rules: [cpuRule('warn-80', 80), cpuRule('crit-95', 95)] }),
      getDataDir: () => dataDir,
    }));
    vi.doMock('../notifications/webhook', () => ({ sendWebhook: vi.fn(async () => undefined) }));

    const { eventBus } = await import('../services/eventBus');
    const { startAlertEngine, stopAlertEngine } = await import('../services/alertEngine');
    const fired: Array<{ ruleId: string }> = [];
    eventBus.on('alert:fired', (a) => fired.push(a));

    startAlertEngine();
    try {
      const snapshot = metricsSnapshot([{ name: 'app-t1-web', tenantId: 't1', cpuPercent: 85, memPercent: 10 }]);
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      eventBus.emit('metrics:snapshot', snapshot);
      vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
      eventBus.emit('metrics:snapshot', snapshot);

      expect(fired.map(a => a.ruleId)).toEqual(['warn-80']);
    } finally {
      stopAlertEngine();
    }
  });
});

async function loadEngine(rules: unknown[], extra: { sendWebhook?: any } = {}) {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.doMock('../config', () => ({ loadConfig: () => ({ alert_rules: rules }), getDataDir: () => dataDir }));
  vi.doMock('../notifications/webhook', () => ({ sendWebhook: extra.sendWebhook ?? vi.fn(async () => undefined) }));
  const { eventBus } = await import('../services/eventBus');
  const engine = await import('../services/alertEngine');
  return { eventBus, ...engine };
}

const downRule = { id: 'down', name: 'Down', condition: { type: 'container_down', duration: '1m' }, cooldown: '1s', severity: 'critical' };

describe('alert engine container_down timers', () => {
  it('does not fire when the container starts again before the duration', async () => {
    vi.useFakeTimers();
    const { eventBus, startAlertEngine, stopAlertEngine } = await loadEngine([downRule]);
    const fired: any[] = [];
    eventBus.on('alert:fired', (a) => fired.push(a));
    startAlertEngine();
    try {
      eventBus.emit('container:event', containerEvent({ action: 'die', containerName: 'app-t1-web' }));
      await vi.advanceTimersByTimeAsync(30_000);
      eventBus.emit('container:event', containerEvent({ action: 'start', containerName: 'app-t1-web' }));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fired).toHaveLength(0);
    } finally {
      stopAlertEngine();
    }
  });

  it('a stop followed by a quick restart and a second stop only fires once, for the later outage', async () => {
    vi.useFakeTimers();
    const { eventBus, startAlertEngine, stopAlertEngine } = await loadEngine([downRule]);
    const fired: any[] = [];
    eventBus.on('alert:fired', (a) => fired.push(a));
    startAlertEngine();
    try {
      eventBus.emit('container:event', containerEvent({ action: 'die', containerName: 'app-t1-web' }));
      await vi.advanceTimersByTimeAsync(30_000);
      eventBus.emit('container:event', containerEvent({ action: 'start', containerName: 'app-t1-web' }));
      eventBus.emit('container:event', containerEvent({ action: 'die', containerName: 'app-t1-web' }));
      await vi.advanceTimersByTimeAsync(40_000); // old timer would fire at 60s from the first die
      expect(fired).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(fired).toHaveLength(1);
    } finally {
      stopAlertEngine();
    }
  });

  it('stopAlertEngine cancels pending down timers', async () => {
    vi.useFakeTimers();
    const { eventBus, startAlertEngine, stopAlertEngine } = await loadEngine([downRule]);
    const fired: any[] = [];
    eventBus.on('alert:fired', (a) => fired.push(a));
    startAlertEngine();
    eventBus.emit('container:event', containerEvent({ action: 'die', containerName: 'app-t1-web' }));
    stopAlertEngine();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fired).toHaveLength(0);
  });
});

describe('alert engine container_down on deliberate stops', () => {
  async function run(actions: string[], { gapMs = 0, waitMs = 120_000 } = {}) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { eventBus, startAlertEngine, stopAlertEngine } = await loadEngine([downRule]);
    const fired: any[] = [];
    const resolved: any[] = [];
    eventBus.on('alert:fired', (a) => fired.push(a));
    eventBus.on('alert:resolved', (a) => resolved.push(a));
    startAlertEngine();
    for (const action of actions) {
      eventBus.emit('container:event', containerEvent({ action, containerName: 'app-t1-web' }));
      if (gapMs) await vi.advanceTimersByTimeAsync(gapMs);
    }
    await vi.advanceTimersByTimeAsync(waitMs);
    return { eventBus, stopAlertEngine, fired, resolved };
  }

  it('does not alert for docker stop / compose stop (kill, die, stop)', async () => {
    const { stopAlertEngine, fired } = await run(['kill', 'die', 'stop']);
    stopAlertEngine();
    expect(fired).toHaveLength(0);
  });

  it('does not alert when stop arrives after die without a kill first', async () => {
    const { stopAlertEngine, fired } = await run(['die', 'stop']);
    stopAlertEngine();
    expect(fired).toHaveLength(0);
  });

  it('does not alert for docker kill (kill, die)', async () => {
    const { stopAlertEngine, fired } = await run(['kill', 'die'], { gapMs: 2_000 });
    stopAlertEngine();
    expect(fired).toHaveLength(0);
  });

  it('sends neither a down alert nor a Resolved for a deleted tenant (compose down), even after eviction', async () => {
    const { eventBus, stopAlertEngine, fired, resolved } = await run(['kill', 'die', 'stop', 'destroy']);
    try {
      eventBus.emit('containers:existence', []);
      vi.setSystemTime(new Date('2026-01-01T00:30:00Z'));
      eventBus.emit('containers:existence', []);
      expect(fired).toHaveLength(0);
      expect(resolved).toHaveLength(0);
    } finally {
      stopAlertEngine();
    }
  });

  it('cancels the pending down timer of a crashed container that is then deleted', async () => {
    const { eventBus, stopAlertEngine, fired, resolved } = await run(['die', 'destroy']);
    try {
      vi.setSystemTime(new Date('2026-01-01T00:30:00Z'));
      eventBus.emit('containers:existence', []);
      expect(fired).toHaveLength(0);
      expect(resolved).toHaveLength(0);
    } finally {
      stopAlertEngine();
    }
  });

  it('still alerts for a crash (die alone)', async () => {
    const { stopAlertEngine, fired } = await run(['die']);
    stopAlertEngine();
    expect(fired).toHaveLength(1);
  });

  it('still alerts for a crash after a restart or an earlier non-fatal signal', async () => {
    const restarted = await run(['kill', 'die', 'stop', 'start', 'die']);
    restarted.stopAlertEngine();
    expect(restarted.fired).toHaveLength(1);
    vi.resetModules();

    // e.g. `docker kill -s HUP` to reload, then a crash well after it
    const reloaded = await run(['kill', 'die'], { gapMs: 5 * 60_000 });
    reloaded.stopAlertEngine();
    expect(reloaded.fired).toHaveLength(1);
  });
});

describe('alert engine lifecycle', () => {
  it('removes its eventBus listeners on stop and restarts cleanly without double firing', async () => {
    vi.useFakeTimers();
    const { eventBus, startAlertEngine, stopAlertEngine } = await loadEngine([downRule]);
    const events = ['metrics:snapshot', 'containers:existence', 'container:event', 'health:change', 'health:probe'] as const;
    const before = events.map(n => eventBus.listenerCount(n));
    startAlertEngine();
    stopAlertEngine();
    expect(events.map(n => eventBus.listenerCount(n))).toEqual(before);

    const fired: any[] = [];
    eventBus.on('alert:fired', (a) => fired.push(a));
    startAlertEngine();
    startAlertEngine(); // idempotent
    try {
      eventBus.emit('container:event', containerEvent({ action: 'die', containerName: 'app-t1-web' }));
      await vi.advanceTimersByTimeAsync(61_000);
      expect(fired).toHaveLength(1);
    } finally {
      stopAlertEngine();
    }
  });
});

// Mirrors the collector: existence goes on an internal event, not the snapshot.
function emitSnap(bus: any, containers: unknown[], existing?: string[]) {
  if (existing) bus.emit('containers:existence', existing);
  bus.emit('metrics:snapshot', { containers });
}

describe('alert engine stale container eviction', () => {
  const hot = { name: 'app-t1-web', tenantId: 't1', cpuPercent: 99, memPercent: 1 };

  async function fireHot(existing: string[]) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const loaded = await loadEngine([cpuRule('warn-80', 80), downRule]);
    const fired: any[] = [];
    const resolved: any[] = [];
    loaded.eventBus.on('alert:fired', (a) => fired.push(a));
    loaded.eventBus.on('alert:resolved', (a) => resolved.push(a));
    loaded.startAlertEngine();
    emitSnap(loaded.eventBus, [hot], existing);
    vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
    emitSnap(loaded.eventBus, [hot], existing);
    return { ...loaded, fired, resolved };
  }

  it('resolves active alerts and drops state for containers missing from the full listing for 10 minutes', async () => {
    const { eventBus, stopAlertEngine, fired, resolved } = await fireHot(['app-t1-web']);
    try {
      expect(fired).toHaveLength(1);
      vi.setSystemTime(new Date('2026-01-01T00:05:00Z'));
      emitSnap(eventBus, [], []);
      expect(resolved).toHaveLength(0);

      vi.setSystemTime(new Date('2026-01-01T00:12:03Z'));
      emitSnap(eventBus, [], []);
      expect(resolved.map(r => r.ruleId)).toEqual(['warn-80']);

      // state is gone: coming back hot restarts its duration (no immediate fire)
      vi.setSystemTime(new Date('2026-01-01T00:20:00Z'));
      emitSnap(eventBus, [hot], ['app-t1-web']);
      expect(fired).toHaveLength(1);
    } finally {
      stopAlertEngine();
    }
  });

  it('keeps the container_down alert of a stopped-but-existing container past 10 minutes', async () => {
    const { eventBus, stopAlertEngine, fired, resolved } = await fireHot(['app-t1-web']);
    try {
      eventBus.emit('container:event', containerEvent({ action: 'die', containerName: 'app-t1-web' }));
      await vi.advanceTimersByTimeAsync(61_000);
      expect(fired.filter(a => a.ruleId === 'down')).toHaveLength(1);

      for (const t of ['00:05:00', '00:12:00', '00:30:00']) {
        vi.setSystemTime(new Date(`2026-01-01T${t}Z`));
        emitSnap(eventBus, [], ['app-t1-web']);
      }
      expect(resolved.filter(r => r.ruleId === 'down')).toHaveLength(0);

      eventBus.emit('container:event', containerEvent({ action: 'start', containerName: 'app-t1-web' }));
      expect(resolved.filter(r => r.ruleId === 'down')).toHaveLength(1);
    } finally {
      stopAlertEngine();
    }
  });

  it('resolves the down alert of a removed container after 10 minutes and evicts its state', async () => {
    const { eventBus, stopAlertEngine, fired, resolved } = await fireHot(['app-t1-web']);
    try {
      eventBus.emit('container:event', containerEvent({ action: 'die', containerName: 'app-t1-web' }));
      await vi.advanceTimersByTimeAsync(61_000);
      expect(fired.filter(a => a.ruleId === 'down')).toHaveLength(1);
      vi.setSystemTime(new Date('2026-01-01T00:12:00Z'));
      emitSnap(eventBus, [], []);
      expect(resolved.filter(r => r.ruleId === 'down')).toHaveLength(1);
    } finally {
      stopAlertEngine();
    }
  });

  it('never evicts when the snapshot carries no existence listing', async () => {
    const { eventBus, stopAlertEngine, resolved } = await fireHot(['app-t1-web']);
    try {
      vi.setSystemTime(new Date('2026-01-01T01:00:00Z'));
      eventBus.emit('metrics:snapshot', metricsSnapshot());
      expect(resolved).toHaveLength(0);
    } finally {
      stopAlertEngine();
    }
  });
});

describe('alert notification channels', () => {
  const channel = { id: '00000000-0000-4000-8000-000000000001', name: 'Hook', type: 'webhook', enabled: true, config: { url: 'https://example.test/h' } };

  it('treats a missing file as no channels but a corrupt file as an error that blocks saving', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getNotificationChannelsData, saveNotificationChannels } = await loadEngine([]);
    expect(await getNotificationChannelsData()).toEqual([]);
    expect(errSpy).not.toHaveBeenCalled();

    const file = path.join(dataDir, 'notification-channels.json');
    await fs.writeFile(file, '{"not": valid');
    expect(await getNotificationChannelsData()).toEqual([]);
    expect(errSpy).toHaveBeenCalled();
    await expect(saveNotificationChannels([channel as any])).rejects.toThrow(/notification-channels\.json/);
    expect(await fs.readFile(file, 'utf-8')).toBe('{"not": valid');
  });

  it('saves normally when the file is missing or valid', async () => {
    const { getNotificationChannelsData, saveNotificationChannels } = await loadEngine([]);
    await saveNotificationChannels([channel as any]);
    await saveNotificationChannels([channel as any, { ...channel, id: 'x' } as any]);
    expect(await getNotificationChannelsData()).toHaveLength(2);
  });

  it('logs a failed webhook delivery from alert dispatch instead of swallowing it', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await fs.writeFile(path.join(dataDir, 'notification-channels.json'), JSON.stringify([channel]));
    const sendWebhook = vi.fn(async () => { throw new Error('Webhook returned 503'); });
    const { eventBus, startAlertEngine, stopAlertEngine } = await loadEngine([cpuRule('warn-80', 80)], { sendWebhook });
    startAlertEngine();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const hot = metricsSnapshot([{ name: 'app-t1-web', tenantId: 't1', cpuPercent: 99, memPercent: 1 }]);
      eventBus.emit('metrics:snapshot', hot);
      vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
      eventBus.emit('metrics:snapshot', hot);
      await vi.waitFor(() => {
        expect(errSpy.mock.calls.some(c => String(c.join(' ')).includes('Webhook returned 503'))).toBe(true);
      });
    } finally {
      stopAlertEngine();
    }
  });
});

describe('alert engine health_check_failed', () => {
  afterEach(() => {
    for (const m of ['dockerode', 'net', 'node-cron', '../services/app']) vi.doUnmock(m);
  });

  // Drives the real health checker, so the test covers what it emits and when.
  async function withHealthChecker(rules: unknown[]) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const world = { healthy: false };
    vi.doMock('node-cron', () => ({
      default: { validate: () => true, schedule: (_e: string, fn: () => void) => { (globalThis as any).__hcTick = fn; return { stop: () => {} }; } },
    }));
    vi.doMock('dockerode', () => ({
      default: class {
        async listContainers() {
          return [{
            Id: 'abcdef123456', Names: ['/app-t1-web'],
            Labels: { 'com.overwatch.managed': 'true', 'com.overwatch.app-id': 'app', 'com.overwatch.tenant-id': 't1', 'com.overwatch.service': 'web' },
          }];
        }
      },
    }));
    vi.doMock('net', () => {
      const createConnection = (_o: unknown, onConnect: () => void) => {
        const socket = Object.assign(new EventEmitter(), { destroy: () => {} });
        Promise.resolve().then(() => (world.healthy ? onConnect() : socket.emit('error', new Error('refused'))));
        return socket;
      };
      return { default: { createConnection }, createConnection };
    });
    vi.doMock('../services/app', () => ({
      listApps: vi.fn(async () => [{ id: 'app', services: [{ name: 'web', ports: { internal: 80 }, health_check: { type: 'tcp', port: 80 } }] }]),
    }));
    const loaded = await loadEngine(rules);
    const fired: any[] = [];
    const resolved: any[] = [];
    const changes: any[] = [];
    loaded.eventBus.on('alert:fired', (a) => fired.push(a));
    loaded.eventBus.on('alert:resolved', (a) => resolved.push(a));
    loaded.eventBus.on('health:change', (c) => changes.push(c));
    loaded.startAlertEngine();
    const hc = await import('../services/healthChecker');
    hc.startHealthChecker();
    await vi.advanceTimersByTimeAsync(0);
    // Each probe is 10s apart and past the 1s cooldown, so only the engine's own logic limits firing.
    const probe = async () => {
      vi.setSystemTime(Date.now() + 10_000);
      await (globalThis as any).__hcTick();
    };
    return { ...loaded, hc, world, fired, resolved, changes, probe };
  }

  const healthRule = (extra: Record<string, unknown> = {}) => ({
    id: 'hc', name: 'Health', condition: { type: 'health_check_failed', ...extra }, cooldown: '1s', severity: 'critical',
  });

  it('fires once the failure count reaches the default threshold of 3, once per outage, and resolves on recovery', async () => {
    const { hc, world, fired, resolved, changes, probe, stopAlertEngine } = await withHealthChecker([healthRule()]);
    try {
      expect(fired).toHaveLength(0); // failure 1
      await probe(); // 2
      expect(fired).toHaveLength(0);
      await probe(); // 3
      expect(fired).toHaveLength(1);
      expect(fired[0]).toMatchObject({ ruleId: 'hc', containerName: 'app-t1-web', tenantId: 't1' });
      expect(fired[0].message).toContain('3 times');

      for (let i = 0; i < 4; i++) await probe(); // still failing: no repeat per probe
      expect(fired).toHaveLength(1);
      expect(resolved).toHaveLength(0);

      world.healthy = true;
      await probe();
      expect(resolved.map(r => r.ruleId)).toEqual(['hc']);
      await probe();
      expect(resolved).toHaveLength(1);

      world.healthy = false;
      for (let i = 0; i < 3; i++) await probe();
      expect(fired).toHaveLength(2); // a new outage alerts again

      // The UI-facing transition event is unchanged: transitions only.
      expect(changes.map(c => c.newState)).toEqual(['unhealthy', 'healthy', 'unhealthy']);
    } finally {
      hc.stopHealthChecker();
      stopAlertEngine();
    }
  });

  it('honours a custom consecutive_failures', async () => {
    const { hc, fired, probe, stopAlertEngine } = await withHealthChecker([healthRule({ consecutive_failures: 5 })]);
    try {
      for (let i = 0; i < 3; i++) await probe(); // failures 2..4
      expect(fired).toHaveLength(0);
      await probe(); // 5
      expect(fired).toHaveLength(1);
    } finally {
      hc.stopHealthChecker();
      stopAlertEngine();
    }
  });
});
