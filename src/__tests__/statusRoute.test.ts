import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../services/docker');
  vi.doUnmock('../services/app');
  vi.doUnmock('../adapters/database');
});

describe('GET /api/status/health', () => {
  it('reports the database as disconnected instead of failing when it is down', async () => {
    const listDatabases = vi.fn(async () => { throw new Error('connect ECONNREFUSED'); });
    vi.doMock('../services/docker', () => ({
      listContainers: vi.fn(async () => []),
      getContainerLogs: vi.fn(),
      restartContainer: vi.fn(),
      listTenants: vi.fn(async () => []),
    }));
    vi.doMock('../services/app', () => ({ listApps: vi.fn(async () => []) }));
    vi.doMock('../adapters/database', () => ({
      getDatabaseAdapter: () => ({ testConnection: async () => false, listDatabases }),
    }));

    const { default: statusRouter } = await import('../routes/status');
    const app = express();
    app.use('/api/status', statusRouter);

    const res = await request(app).get('/api/status/health').expect(200);
    expect(res.body.database).toBe('disconnected');
    expect(res.body.databases).toBe(0);
    expect(listDatabases).not.toHaveBeenCalled();
  });
});
