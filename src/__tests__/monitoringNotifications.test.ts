import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

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
  vi.doUnmock('../utils/jwt');
});

async function getChannelsAs(email: string, role: 'viewer' | 'admin' | undefined) {
  vi.doMock('../services/alertEngine', () => ({
    getAlertHistory: vi.fn(),
    getNotificationChannelsData: vi.fn(async () => [CHANNEL]),
    saveNotificationChannels: vi.fn(),
    sendTestNotification: vi.fn(),
  }));
  vi.doMock('../utils/jwt', () => ({ getCurrentUserEmail: () => email }));
  vi.doMock('../services/users', async () => ({
    ...(await vi.importActual<typeof import('../services/users')>('../services/users')),
    getUserRole: vi.fn(async () => role),
  }));
  const { default: router } = await import('../routes/monitoring');
  const app = express();
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
