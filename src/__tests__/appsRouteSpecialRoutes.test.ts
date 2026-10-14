import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import express from 'express';
import * as http from 'http';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-apps-route-special-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.doUnmock('../services/app');
  vi.doUnmock('../adapters/registry');
  vi.doUnmock('../services/traefikConfig');
  vi.resetModules();
});

async function requestApp(app: express.Express, route: string): Promise<{ status: number; body: any }> {
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind to a port');
    const res = await fetch(`http://127.0.0.1:${address.port}${route}`);
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
}

describe('apps router special routes', () => {
  it('serves /.trashed before the dynamic /:appId route', async () => {
    vi.doMock('../services/app', () => ({
      listApps: vi.fn(),
      getApp: vi.fn(),
      createApp: vi.fn(),
      updateApp: vi.fn(),
      deleteApp: vi.fn(),
      listTrashedApps: vi.fn(async () => [{ app: { id: 'acme' }, deletedAt: 'now', deletedBy: 'me', tenantCount: 1 }]),
      restoreApp: vi.fn(),
      purgeApp: vi.fn(),
    }));
    vi.doMock('../adapters/registry', () => ({ getImageTagsForApp: vi.fn() }));
    vi.doMock('../services/traefikConfig', () => ({ getAppTraefik: vi.fn(), updateAppTraefik: vi.fn() }));

    const { default: appsRouter } = await import('../routes/apps');
    const app = express();
    app.use(express.json());
    app.use('/api/apps', appsRouter);

    const response = await requestApp(app, '/api/apps/.trashed');
    expect(response.status).toBe(200);
    expect(response.body[0].app.id).toBe('acme');
  });
});


