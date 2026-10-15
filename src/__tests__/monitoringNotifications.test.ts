import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import dns from 'dns';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const CHANNEL = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Ops Slack',
  type: 'webhook',
  enabled: true,
  config: {
    url: 'https://hooks.slack.com/services/T000/B000/SECRETPATH',
    headers: { Authorization: 'Bearer top-secret' },
  },
};

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../services/alertEngine');
  vi.doUnmock('../services/users');
});

async function getChannelsAs(email: string, role: 'viewer' | 'admin' | undefined) {
  vi.doMock('../services/alertEngine', () => ({
    getAlertHistory: vi.fn(),
    getNotificationChannelsData: vi.fn(async () => [CHANNEL]),
    updateNotificationChannels: vi.fn(),
    sendTestNotification: vi.fn(),
  }));
  const { default: router } = await import('../routes/monitoring');
  const app = express();
  // Stands in for authMiddleware, which resolves the caller once per request.
  app.use((_req, res, next) => { if (role) res.locals.user = { email, role }; next(); });
  app.use('/api/monitoring', router);
  return request(app).get('/api/monitoring/notifications').expect(200);
}

describe('GET /api/monitoring/notifications', () => {
  it('redacts webhook URL host, path and header values for viewers', async () => {
    const res = await getChannelsAs('viewer@example.test', 'viewer');
    const [channel] = res.body;
    expect(channel.name).toBe('Ops Slack');
    expect(channel.config.url).toBe('https://••••••••');
    expect(channel.config.headers).toEqual({ Authorization: '••••••••' });
    expect(JSON.stringify(res.body)).not.toMatch(/SECRETPATH|top-secret/);
  });

  it('redacts for a caller that is not an admin user at all (no fail-open)', async () => {
    const res = await getChannelsAs('gone@example.test', undefined);
    expect(JSON.stringify(res.body)).not.toMatch(/SECRETPATH|top-secret|hooks\.slack\.com/);
  });

  it('returns the full channel config to admins (needed to edit it)', async () => {
    const res = await getChannelsAs('admin@example.test', 'admin');
    expect(res.body).toEqual([CHANNEL]);
  });
});

describe('POST /api/monitoring/notifications/:id/test', () => {
  async function post(sendTestNotification: () => Promise<void>) {
    vi.doMock('../services/alertEngine', () => ({
      getAlertHistory: vi.fn(),
      getNotificationChannelsData: vi.fn(async () => [CHANNEL]),
      updateNotificationChannels: vi.fn(),
      sendTestNotification,
    }));
    const { default: router } = await import('../routes/monitoring');
    const app = express();
    app.use((_req, res, next) => { res.locals.user = { email: 'admin@example.test', role: 'admin' }; next(); });
    app.use('/api/monitoring', router);
    return request(app).post(`/api/monitoring/notifications/${CHANNEL.id}/test`);
  }

  it('reports a failed delivery as a 502 with the reason', async () => {
    const res = await post(async () => { throw new Error('Webhook returned 503'); });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('Webhook returned 503');
  });

  it('reports success when delivery works', async () => {
    const res = await post(async () => undefined);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });
});

describe('notification channel edits against the real store', () => {
  let dataDir: string;

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.doUnmock('../config');
    vi.doUnmock('../utils/security');
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  async function realApp() {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-channel-edits-'));
    vi.doMock('../config', () => ({ getDataDir: () => dataDir, loadConfig: () => ({}) }));
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // A slow write widens the window in which an unlocked read-modify-write loses updates.
    vi.doMock('../utils/security', async (orig) => {
      const actual = await orig<typeof import('../utils/security')>();
      return {
        ...actual,
        writeSecretFile: async (file: string, content: string) => {
          await new Promise(r => setTimeout(r, 20));
          await actual.writeSecretFile(file, content);
        },
      };
    });
    const { default: router } = await import('../routes/monitoring');
    const { errorHandler } = await import('../middleware/errorHandler');
    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => { res.locals.user = { email: 'admin@example.test', role: 'admin' }; next(); });
    app.use('/api/monitoring', router);
    app.use(errorHandler);
    return app;
  }

  it('keeps every concurrent create and edit instead of losing all but one', async () => {
    const app = await realApp();
    await Promise.all(Array.from({ length: 5 }, (_, i) =>
      request(app).post('/api/monitoring/notifications').send({ name: `c${i}`, config: { url: 'https://hooks.example.com/x' } }).expect(200)));
    const created = (await request(app).get('/api/monitoring/notifications').expect(200)).body;
    expect(created.map((c: any) => c.name).sort()).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);

    await Promise.all(created.map((c: any) =>
      request(app).put(`/api/monitoring/notifications/${c.id}`).send({ name: `${c.name}-renamed` }).expect(200)));
    await Promise.all(created.slice(0, 2).map((c: any) =>
      request(app).delete(`/api/monitoring/notifications/${c.id}`).expect(200)));
    const after = (await request(app).get('/api/monitoring/notifications').expect(200)).body;
    expect(after.map((c: any) => c.name).sort()).toEqual(created.slice(2).map((c: any) => `${c.name}-renamed`).sort());
  });

  it('answers 404 for an unknown channel and leaves the file untouched', async () => {
    const app = await realApp();
    await request(app).post('/api/monitoring/notifications').send({ name: 'keep', config: { url: 'https://hooks.example.com/x' } }).expect(200);
    const file = path.join(dataDir, 'notification-channels.json');
    const before = await fs.readFile(file, 'utf-8');
    const missing = '00000000-0000-4000-8000-0000000000ff';
    expect((await request(app).put(`/api/monitoring/notifications/${missing}`).send({ name: 'x' }).expect(404)).body).toEqual({ error: 'Channel not found' });
    expect((await request(app).delete(`/api/monitoring/notifications/${missing}`).expect(404)).body).toEqual({ error: 'Channel not found' });
    expect(await fs.readFile(file, 'utf-8')).toBe(before);
  });
});
