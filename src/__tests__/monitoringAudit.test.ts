import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import dns from 'dns';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let dataDir: string;
const saveNotificationChannels = vi.fn();
const prev = process.env.OVERWATCH_ALLOW_PRIVATE_WEBHOOK;

beforeEach(async () => {
  saveNotificationChannels.mockClear();
  delete process.env.OVERWATCH_ALLOW_PRIVATE_WEBHOOK;
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-monitoring-audit-'));
  vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any);
  vi.doMock('../config', () => ({ getDataDir: () => dataDir, loadConfig: () => ({}) }));
  vi.doMock('../services/alertEngine', () => ({
    getAlertHistory: vi.fn(),
    getNotificationChannelsData: vi.fn(async () => []),
    saveNotificationChannels,
    sendTestNotification: vi.fn(),
  }));
});

afterEach(async () => {
  if (prev === undefined) delete process.env.OVERWATCH_ALLOW_PRIVATE_WEBHOOK;
  else process.env.OVERWATCH_ALLOW_PRIVATE_WEBHOOK = prev;
  vi.restoreAllMocks();
  vi.resetModules();
  for (const m of ['../config', '../services/alertEngine']) vi.doUnmock(m);
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function appWithAudit() {
  const { default: router } = await import('../routes/monitoring');
  const { auditLog } = await import('../middleware/audit');
  const app = express();
  app.use(express.json());
  // Stands in for authMiddleware, which resolves the caller once per request.
  app.use((_req, res, next) => { res.locals.user = { email: 'admin@example.test', role: 'admin' }; next(); });
  app.use('/api/monitoring', auditLog, router);
  return app;
}

async function readAudit() {
  const svc = await import('../services/auditLog');
  await svc.flushAuditLog();
  const raw = await fs.readFile(path.join(dataDir, 'audit.log'), 'utf-8');
  return { raw, entries: raw.trim().split('\n').map(l => JSON.parse(l)) };
}

describe('monitoring mutations are audited without secrets', () => {
  it('records channel creation with the URL reduced to its origin and header values masked', async () => {
    const app = await appWithAudit();
    await request(app).post('/api/monitoring/notifications').send({
      name: 'Ops',
      config: { url: 'https://hooks.example.com/services/T0/B0/SECRETPATH?token=abc', headers: { 'X-Hook': 'hunter2', Foo: 'bar' } },
    }).expect(200);
    const { raw, entries } = await readAudit();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toMatch(/notification channel/);
    expect(entries[0].user).toBe('admin@example.test');
    expect(entries[0].body.config.url).toBe('https://hooks.example.com');
    expect(entries[0].body.config.headers).toEqual({ 'X-Hook': '[redacted]', Foo: '[redacted]' });
    expect(raw).not.toMatch(/SECRETPATH|hunter2|token=abc|bar/);
  });

  it('records update and delete too', async () => {
    const app = await appWithAudit();
    const id = '00000000-0000-4000-8000-000000000009';
    await request(app).put(`/api/monitoring/notifications/${id}`).send({ name: 'x' });
    await request(app).delete(`/api/monitoring/notifications/${id}`);
    const { entries } = await readAudit();
    expect(entries.map(e => e.method)).toEqual(['PUT', 'DELETE']);
    expect(entries[0].action).toMatch(/update notification channel/);
    expect(entries[1].action).toMatch(/delete notification channel/);
  });

  it('rejects a webhook URL whose AAAA record is private with 400', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 }, { address: 'fd00::1', family: 6 },
    ] as any);
    const app = await appWithAudit();
    const res = await request(app).post('/api/monitoring/notifications').send({ name: 'x', config: { url: 'https://rebind.example.com/' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/private/);
    expect(saveNotificationChannels).not.toHaveBeenCalled();
  });
});

describe('webhookUrlError', () => {
  it('rejects a non-string url', async () => {
    const { webhookUrlError } = await import('../routes/monitoring');
    expect(await webhookUrlError(undefined)).toMatch(/Invalid/);
  });
});

describe('audit sanitiser', () => {
  it('masks headers regardless of key case', async () => {
    const { sanitizeBody } = await import('../services/auditLog');
    expect(sanitizeBody({ config: { url: 'https://a.test/x', Headers: { 'X-Hook': 'v' } } }))
      .toEqual({ config: { url: 'https://a.test', Headers: { 'X-Hook': '[redacted]' } } });
  });

  it('only rewrites config.url, leaving other url fields intact', async () => {
    const { sanitizeBody } = await import('../services/auditLog');
    expect(sanitizeBody({ url: 'https://registry.example.com/path', config: { url: 'https://a.test/p?q=1' } }))
      .toEqual({ url: 'https://registry.example.com/path', config: { url: 'https://a.test' } });
    expect(sanitizeBody({ config: { url: 'garbage' } })).toEqual({ config: { url: '[redacted]' } });
  });
});
