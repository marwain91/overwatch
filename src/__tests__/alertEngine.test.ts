import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-alert-engine-'));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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
      const snapshot = { containers: [{ name: 'app-t1-web', tenantId: 't1', cpuPercent: 85, memPercent: 10 }] };
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
