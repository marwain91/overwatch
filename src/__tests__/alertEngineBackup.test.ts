import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let dataDir: string;
let apps: any[] = [];
/** appId -> tenant ids (tenant directories). */
let tenants: Record<string, string[]> = {};
/** appId -> snapshots, newest first (as listSnapshotsCached returns them). */
let snapshots: Record<string, Array<{ tenantId?: string; time: string }>> = {};

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-alert-backup-'));
  apps = [];
  tenants = {};
  snapshots = {};
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  const { jsonlLogFor } = await import('../utils/jsonlLog');
  await jsonlLogFor(path.join(dataDir, 'alert-history.jsonl')).flush();
  vi.resetModules();
  for (const m of ['../config', '../notifications/webhook', '../services/app', '../services/tenantStore', '../services/backupCache']) vi.doUnmock(m);
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function loadEngine(rules: unknown[]) {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.doMock('../config', () => ({ loadConfig: () => ({ alert_rules: rules }), getDataDir: () => dataDir }));
  vi.doMock('../notifications/webhook', () => ({ sendWebhook: vi.fn(async () => undefined) }));
  vi.doMock('../services/app', () => ({ listApps: vi.fn(async () => apps) }));
  vi.doMock('../services/tenantStore', () => ({
    listTenantDirs: vi.fn(async (appId: string) => (tenants[appId] ?? []).map(tenantId => ({ appId, tenantId, dir: `/x/${tenantId}` }))),
  }));
  vi.doMock('../services/backupCache', () => ({ listSnapshotsCached: vi.fn(async (appId: string) => snapshots[appId] ?? []) }));
  const { eventBus } = await import('../services/eventBus');
  const engine = await import('../services/alertEngine');
  const fired: any[] = [];
  const resolved: any[] = [];
  eventBus.on('alert:fired', (a) => fired.push(a));
  eventBus.on('alert:resolved', (a) => resolved.push(a));
  return { eventBus, fired, resolved, ...engine };
}

const failedRule = { id: 'bk-failed', name: 'Backup failed', condition: { type: 'backup_failed' }, cooldown: '1s', severity: 'critical' };
const staleRule = (hours?: number) => ({
  id: 'bk-stale', name: 'Backup stale', condition: { type: 'backup_stale', ...(hours ? { max_age_hours: hours } : {}) }, cooldown: '1h', severity: 'warning',
});

describe('backup_failed rule', () => {
  it('fires for the failed tenant and resolves on its next successful backup only', async () => {
    const { eventBus, fired, resolved, startAlertEngine, stopAlertEngine } = await loadEngine([failedRule]);
    startAlertEngine();
    try {
      eventBus.emit('backup:failed', { appId: 'shop', tenantId: 't1', reason: 'Repository is locked by another operation.' });
      expect(fired).toHaveLength(1);
      expect(fired[0]).toMatchObject({ ruleId: 'bk-failed', tenantId: 't1' });
      expect(fired[0].message).toMatch(/shop\/t1.*locked/);

      eventBus.emit('backup:completed', { appId: 'shop', tenantId: 't2' });
      expect(resolved).toHaveLength(0);
      eventBus.emit('backup:completed', { appId: 'shop', tenantId: 't1' });
      expect(resolved.map(r => r.ruleId)).toEqual(['bk-failed']);
    } finally {
      stopAlertEngine();
    }
  });

  it('fires for a run that could not start and resolves once a backup of the app succeeds', async () => {
    const { eventBus, fired, resolved, startAlertEngine, stopAlertEngine } = await loadEngine([failedRule]);
    startAlertEngine();
    try {
      eventBus.emit('backup:failed', { appId: 'shop', reason: "Could not list the tenants of app 'shop'." });
      expect(fired[0].message).toMatch(/shop.*Could not list/);
      eventBus.emit('backup:completed', { appId: 'shop', tenantId: 't1' });
      expect(resolved).toHaveLength(1);
    } finally {
      stopAlertEngine();
    }
  });

  it('treats an incomplete backup as a failure that does not resolve the alert', async () => {
    const { eventBus, fired, resolved, startAlertEngine, stopAlertEngine } = await loadEngine([failedRule]);
    startAlertEngine();
    try {
      eventBus.emit('backup:completed', { appId: 'shop', tenantId: 't1', incomplete: true, missingPaths: ['web:/data'] });
      expect(fired).toHaveLength(1);
      expect(fired[0].message).toMatch(/incomplete.*web:\/data/);
      expect(resolved).toHaveLength(0);
    } finally {
      stopAlertEngine();
    }
  });
});

describe('backup_stale rule', () => {
  const app = (id: string, schedule?: string, enabled = true) => ({ id, backup: { enabled, ...(schedule ? { schedule } : {}) } });
  const HOUR = 60 * 60 * 1000;

  it('fires for a tenant with no successful backup for max_age_hours, and resolves on its next one', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    apps = [app('shop', '0 2 * * *'), app('manual'), app('off', '0 2 * * *', false)];
    tenants = { shop: ['t1'], manual: ['m1'], off: ['o1'] };
    const { eventBus, fired, resolved, startAlertEngine, stopAlertEngine } = await loadEngine([staleRule(2)]);
    startAlertEngine();
    try {
      await vi.advanceTimersByTimeAsync(HOUR);
      eventBus.emit('backup:completed', { appId: 'shop', tenantId: 't1' });
      await vi.advanceTimersByTimeAsync(119 * 60 * 1000);
      expect(fired).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(fired.map(a => a.message)).toEqual([expect.stringMatching(/shop\/t1.*2 h/)]);
      expect(fired[0].tenantId).toBe('t1');

      eventBus.emit('backup:completed', { appId: 'shop', tenantId: 't1' });
      expect(resolved.map(r => r.ruleId)).toEqual(['bk-stale']);
    } finally {
      stopAlertEngine();
    }
  });

  it('does not let one healthy tenant hide another that is not backed up', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    apps = [app('shop', '0 * * * *')];
    tenants = { shop: ['t1', 't2'] };
    const { eventBus, fired, startAlertEngine, stopAlertEngine } = await loadEngine([staleRule(2)]);
    startAlertEngine();
    try {
      for (let h = 0; h < 3; h++) {
        await vi.advanceTimersByTimeAsync(HOUR);
        eventBus.emit('backup:completed', { appId: 'shop', tenantId: 't1' });
      }
      expect(fired.map(a => a.tenantId)).toEqual(['t2']);
    } finally {
      stopAlertEngine();
    }
  });

  // In memory only, every restart would start the clock again.
  it('counts from the newest snapshot of the tenant, so a restart does not reset the age', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-03T00:00:00Z'));
    apps = [app('shop', '0 2 * * *')];
    tenants = { shop: ['t1', 't2'] };
    snapshots = { shop: [{ tenantId: 't2', time: '2026-01-02T20:00:00Z' }, { tenantId: 't1', time: '2026-01-01T20:00:00Z' }] };
    const { fired, startAlertEngine, stopAlertEngine } = await loadEngine([staleRule()]);
    startAlertEngine();
    try {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(fired.map(a => a.tenantId)).toEqual(['t1']);
    } finally {
      stopAlertEngine();
    }
  });

  it('counts from engine start for a tenant that never had a backup, with a 26 h default', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    apps = [app('shop', '0 2 * * *')];
    tenants = { shop: ['t1'] };
    const { fired, startAlertEngine, stopAlertEngine } = await loadEngine([staleRule()]);
    startAlertEngine();
    try {
      await vi.advanceTimersByTimeAsync(25 * HOUR);
      expect(fired).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2 * HOUR);
      expect(fired).toHaveLength(1);
    } finally {
      stopAlertEngine();
    }
  });

  it('resolves the alert of a tenant that was deleted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    apps = [app('shop', '0 2 * * *')];
    tenants = { shop: ['t1'] };
    const { fired, resolved, startAlertEngine, stopAlertEngine } = await loadEngine([staleRule(1)]);
    startAlertEngine();
    try {
      await vi.advanceTimersByTimeAsync(2 * HOUR);
      expect(fired).toHaveLength(1);
      tenants = { shop: [] };
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(resolved).toHaveLength(1);
    } finally {
      stopAlertEngine();
    }
  });

  it('stops checking and drops its listeners when the engine stops', async () => {
    vi.useFakeTimers();
    apps = [app('shop', '0 2 * * *')];
    tenants = { shop: ['t1'] };
    const { eventBus, fired, startAlertEngine, stopAlertEngine } = await loadEngine([staleRule(1), failedRule]);
    const before = ['backup:completed', 'backup:failed'].map(n => eventBus.listenerCount(n as any));
    startAlertEngine();
    stopAlertEngine();
    expect(['backup:completed', 'backup:failed'].map(n => eventBus.listenerCount(n as any))).toEqual(before);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3 * HOUR);
    expect(fired).toHaveLength(0);
  });
});

describe('alert rule schema', () => {
  it('accepts the backup condition types and max_age_hours', async () => {
    const { AlertRuleSchema } = await import('../config/schema');
    expect(AlertRuleSchema.parse(staleRule(12)).condition).toEqual({ type: 'backup_stale', max_age_hours: 12 });
    expect(AlertRuleSchema.parse(failedRule).condition.type).toBe('backup_failed');
    expect(() => AlertRuleSchema.parse(staleRule(-1))).toThrow();
  });
});
