import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { metricsSnapshot } from './eventFixtures';

let dataDir: string;
// Mutable so a test can change the loaded config without re-mocking '../config'
// (re-mocking a path registered in beforeEach races inside vitest's mock queue).
let configValue: unknown;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-retention-'));
  configValue = { retention: { max_alert_entries: 3, max_audit_entries: 3 } };
  vi.doMock('../config', () => ({
    getDataDir: () => dataDir,
    loadConfig: () => configValue,
  }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('../config');
  await fs.rm(dataDir, { recursive: true, force: true });
});

const lines = async (f: string) => (await fs.readFile(path.join(dataDir, f), 'utf-8')).trim().split('\n');

describe('retention', () => {
  it('prunes audit and alert history without losing entries appended meanwhile', async () => {
    const { writeAuditEntry, flushAuditLog } = await import('../services/auditLog');
    const { jsonlLogFor } = await import('../utils/jsonlLog');
    const alertLog = jsonlLogFor(path.join(dataDir, 'alert-history.jsonl'));
    for (let i = 0; i < 5; i++) {
      writeAuditEntry({ user: 'u', action: `a${i}`, method: 'POST', path: '/p', status: 200, ip: 'x' });
      alertLog.append(JSON.stringify({ id: `h${i}` }));
    }
    await flushAuditLog();
    await alertLog.flush();

    const { runRetention } = await import('../services/retention');
    const running = runRetention();
    writeAuditEntry({ user: 'u', action: 'late', method: 'POST', path: '/p', status: 200, ip: 'x' });
    alertLog.append(JSON.stringify({ id: 'late' }));
    await running;
    await flushAuditLog();
    await alertLog.flush();

    expect((await lines('audit.log')).map(l => JSON.parse(l).action)).toEqual(['a3', 'a4', 'late']);
    expect((await lines('alert-history.jsonl')).map(l => JSON.parse(l).id)).toEqual(['h3', 'h4', 'late']);
    for (const f of ['audit.log', 'alert-history.jsonl']) {
      expect((await fs.stat(path.join(dataDir, f))).mode & 0o777).toBe(0o600);
    }
  });

  it('also caps each log at 32 MiB, keeping the newest entries', async () => {
    configValue = { retention: { max_alert_entries: 1_000_000, max_audit_entries: 1_000_000 } };
    const pad = 'x'.repeat(3000);
    const n = 12_000; // ~36 MB
    const body = Array.from({ length: n }, (_, i) => JSON.stringify({ user: 'u', action: `a${i}`, method: 'POST', path: '/p', status: 200, ip: 'x', pad })).join('\n') + '\n';
    await fs.writeFile(path.join(dataDir, 'audit.log'), body, { mode: 0o600 });
    const { runRetention } = await import('../services/retention');
    await runRetention();
    const file = path.join(dataDir, 'audit.log');
    expect((await fs.stat(file)).size).toBeLessThanOrEqual(32 * 1024 * 1024);
    const kept = await lines('audit.log');
    expect(JSON.parse(kept[0]).action).toMatch(/^a\d+$/);
    expect(JSON.parse(kept.at(-1)!).action).toBe(`a${n - 1}`);
    expect(kept.length).toBeGreaterThan(10_000);
  });

  it('leaves no temp files behind and tolerates missing files', async () => {
    const { runRetention } = await import('../services/retention');
    await runRetention();
    expect(await fs.readdir(dataDir)).not.toContain('audit.log');
    expect((await fs.readdir(dataDir)).filter(f => f.includes('.tmp.'))).toEqual([]);
  });
});

describe('alert history appends', () => {
  it('go through the shared serialized writer, so a concurrent prune cannot drop them', async () => {
    vi.doMock('../notifications/webhook', () => ({ sendWebhook: vi.fn(async () => undefined) }));
    configValue = {
      alert_rules: [{ id: 'r', name: 'cpu', condition: { type: 'cpu_threshold', threshold: 1, duration: '1s' }, cooldown: '1s', severity: 'warning' }],
      retention: { max_alert_entries: 2 },
    };
    const file = path.join(dataDir, 'alert-history.jsonl');
    await fs.writeFile(file, '{"id":"old1"}\n{"id":"old2"}\n', { mode: 0o644 });
    const { jsonlLogFor } = await import('../utils/jsonlLog');
    const { eventBus } = await import('../services/eventBus');
    const { startAlertEngine, stopAlertEngine } = await import('../services/alertEngine');
    vi.useFakeTimers();
    startAlertEngine();
    try {
      const snap = metricsSnapshot([{ name: 'c', tenantId: 't', cpuPercent: 50, memPercent: 1 }]);
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      eventBus.emit('metrics:snapshot', snap);
      vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
      const pruned = jsonlLogFor(file).prune(2);
      eventBus.emit('metrics:snapshot', snap);
      vi.useRealTimers();
      await pruned;
      await jsonlLogFor(file).flush();
    } finally {
      stopAlertEngine();
      vi.useRealTimers();
    }
    const rows = (await lines('alert-history.jsonl')).map(l => JSON.parse(l));
    expect(rows.map(r => r.id).slice(0, 1)).toEqual(['old2']);
    expect(rows).toHaveLength(2);
    expect(rows[1].ruleId).toBe('r');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });
});
