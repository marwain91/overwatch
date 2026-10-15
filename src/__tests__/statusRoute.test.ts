import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../services/docker');
  vi.doUnmock('../services/app');
  vi.doUnmock('../adapters/database');
  vi.doUnmock('dockerode');
  vi.doUnmock('../middleware/requireRole');
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

describe('status route Docker access', () => {
  const managedLabels = {
    'com.overwatch.managed': 'true', 'com.overwatch.app-id': 'app',
    'com.overwatch.tenant-id': 't1', 'com.overwatch.service': 'web',
  };

  async function build(containers: any[], extra: { testConnection?: () => Promise<boolean> } = {}) {
    const listContainers = vi.fn(async (opts?: any) => {
      const ids: string[] | undefined = opts?.filters?.id;
      return ids ? containers.filter(c => ids.some(i => c.Id.startsWith(i))) : containers;
    });
    const logs = vi.fn(async () => Buffer.from('log line'));
    const restart = vi.fn(async () => undefined);
    const getContainer = vi.fn(() => ({ logs, restart }));
    vi.doMock('dockerode', () => ({ default: class { listContainers = listContainers; getContainer = getContainer; } }));
    const listApps = vi.fn(async () => [{ id: 'app', services: [{ name: 'web' }] }]);
    vi.doMock('../services/app', () => ({ listApps }));
    vi.doMock('../middleware/requireRole', () => ({ requireRole: () => (_q: any, _r: any, n: any) => n() }));
    vi.doMock('../adapters/database', () => ({
      getDatabaseAdapter: () => ({ testConnection: extra.testConnection ?? (async () => true), listDatabases: async () => ['d'] }),
    }));
    const { default: statusRouter } = await import('../routes/status');
    const app = express();
    app.use('/api/status', statusRouter);
    return { app, listContainers, logs, restart, listApps };
  }

  const managed = { Id: 'abcdef123456'.padEnd(64, '0'), Names: ['/app-t1-web'], State: 'running', Status: 'Up', Image: 'i', Created: 1, Labels: managedLabels };
  const stranger = { Id: 'fedcba654321'.padEnd(64, '0'), Names: ['/some-other-thing'], State: 'running', Status: 'Up', Image: 'i', Created: 1, Labels: {} };

  it('looks a container up with an id filter instead of listing everything', async () => {
    const { app, listContainers, logs } = await build([managed, stranger]);
    const res = await request(app).get('/api/status/containers/abcdef123456/logs').expect(200);
    expect(res.body.logs).toBe('log line');
    expect(listContainers).toHaveBeenCalledTimes(1);
    expect(listContainers.mock.calls[0][0]).toMatchObject({ all: true, filters: { id: ['abcdef123456'] } });
    expect(logs).toHaveBeenCalled();
  });

  it('keeps the 404 for ids that exist in Docker but are not managed', async () => {
    const { app, logs, restart } = await build([managed, stranger]);
    await request(app).get('/api/status/containers/fedcba654321/logs').expect(404);
    await request(app).post('/api/status/containers/fedcba654321/restart').expect(404);
    await request(app).get('/api/status/containers/0123456789ab/logs').expect(404);
    expect(logs).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it('refuses a managed-looking container of an app that is not defined', async () => {
    const orphan = { ...managed, Id: '111111111111'.padEnd(64, '0'), Labels: { ...managedLabels, 'com.overwatch.app-id': 'gone' }, Names: ['/gone-t1-web'] };
    const { app, restart } = await build([orphan]);
    await request(app).post('/api/status/containers/111111111111/restart').expect(404);
    expect(restart).not.toHaveBeenCalled();
  });

  it('health: reads the apps once and overlaps the DB and Docker calls', async () => {
    let release!: (v: boolean) => void;
    const gate = new Promise<boolean>(r => { release = r; });
    const { app, listContainers, listApps } = await build([managed], { testConnection: () => gate });
    const pending = request(app).get('/api/status/health').then(r => r);
    // Docker must be queried while the DB connection test is still pending.
    await vi.waitFor(() => expect(listContainers).toHaveBeenCalled());
    release(true);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ database: 'connected', containers: 1, databases: 1, apps: 1 });
    expect(listApps).toHaveBeenCalledTimes(1);
  });
});

describe('container logs role gate', () => {
  async function build(role: 'viewer' | 'editor' | 'admin') {
    const getContainerLogs = vi.fn(async () => 'secret log line');
    vi.doMock('../services/docker', () => ({
      listContainers: vi.fn(async () => []),
      findManagedContainer: vi.fn(async (id: string) => ({ id })),
      getContainerLogs,
      restartContainer: vi.fn(),
      listTenants: vi.fn(async () => []),
    }));
    const { default: statusRouter } = await import('../routes/status');
    const app = express();
    app.use('/api/status', (_req, res, next) => { res.locals.user = { email: 'u@b.c', role }; next(); }, statusRouter);
    return { app, getContainerLogs };
  }

  it('refuses a viewer: tenant logs can hold PII and tokens', async () => {
    const { app, getContainerLogs } = await build('viewer');
    const res = await request(app).get('/api/status/containers/abcdef123456/logs');
    expect(res.status).toBe(403);
    expect(getContainerLogs).not.toHaveBeenCalled();
  });

  it('serves an editor', async () => {
    const { app } = await build('editor');
    const res = await request(app).get('/api/status/containers/abcdef123456/logs').expect(200);
    expect(res.body.logs).toBe('secret log line');
  });
});
