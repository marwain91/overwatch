import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// POST /api/traefik/reload restarts the Traefik container through runDocker,
// which passes docker only an allowlisted environment and enforces a timeout.

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  for (const m of ['../config', '../utils/runDocker', '../services/app']) vi.doUnmock(m);
});

async function mount(runDocker: (...args: any[]) => Promise<unknown>) {
  vi.doMock('../config', async () => ({
    ...(await vi.importActual<any>('../config')),
    loadConfig: () => ({ project: { name: 'Acme', prefix: 'acme', db_prefix: 'acme' } }),
  }));
  vi.doMock('../utils/runDocker', () => ({ runDocker }));
  vi.doMock('../services/app', () => ({ getApp: async () => null, applyApp: async () => ({}) }));
  const { default: router } = await import('../routes/traefik');
  const app = express();
  app.use((_req, res, next) => { res.locals.user = { email: 'a@example.test', role: 'admin' }; next(); });
  app.use('/api/traefik', router);
  return app;
}

const settle = () => new Promise(r => setImmediate(() => setImmediate(r)));

describe('POST /api/traefik/reload', () => {
  it('replies first, then restarts the container through runDocker with a timeout', async () => {
    const runDocker = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const res = await request(await mount(runDocker)).post('/api/traefik/reload').expect(200);
    expect(res.body).toMatchObject({ success: true, container: 'acme-traefik' });
    await settle();
    expect(runDocker).toHaveBeenCalledWith('docker', ['restart', 'acme-traefik'], expect.objectContaining({ timeoutMs: expect.any(Number) }));
  });

  it('a failed restart is logged, not thrown', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runDocker = vi.fn(async () => { throw new Error('docker restart acme-traefik failed (unknown_container)'); });
    await request(await mount(runDocker)).post('/api/traefik/reload').expect(200);
    await settle();
    expect(error.mock.calls.flat().join(' ')).toMatch(/acme-traefik/);
  });
});
