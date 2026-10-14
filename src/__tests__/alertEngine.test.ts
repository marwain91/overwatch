import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
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

describe('alert engine lifecycle', () => {
  it('removes its eventBus listeners on stop and restarts cleanly without double firing', async () => {
    vi.useFakeTimers();
    const { eventBus, startAlertEngine, stopAlertEngine } = await loadEngine([downRule]);
    const before = ['metrics:snapshot', 'containers:existence', 'container:event', 'health:change'].map(n => eventBus.listenerCount(n));
    startAlertEngine();
    stopAlertEngine();
    expect(['metrics:snapshot', 'containers:existence', 'container:event', 'health:change'].map(n => eventBus.listenerCount(n))).toEqual(before);

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
