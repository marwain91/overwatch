import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import * as http from 'http';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-safe-fixes-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.doUnmock('../services/app');
  vi.doUnmock('../adapters/registry');
  vi.doUnmock('../services/traefikConfig');
  vi.doUnmock('../config');
  vi.doUnmock('./fileLock');
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

describe('tenant input validation', () => {
  it('rejects newlines and unsafe characters in image tags', async () => {
    const mod = await import('../services/tenant');
    expect((mod as any).validateImageTag('1.2.3').valid).toBe(true);
    expect((mod as any).validateImageTag('release-2026.05.19').valid).toBe(true);
    expect((mod as any).validateImageTag('latest\nDB_PASSWORD=pwned').valid).toBe(false);
    expect((mod as any).validateImageTag('bad tag').valid).toBe(false);
  });

  it('rejects newlines and malformed tenant domains', async () => {
    const mod = await import('../services/tenant');
    expect((mod as any).validateTenantDomain('acme.example.com').valid).toBe(true);
    expect((mod as any).validateTenantDomain('xn--bcher-kva.example').valid).toBe(true);
    expect((mod as any).validateTenantDomain('acme.example.com\nIMAGE_TAG=pwned').valid).toBe(false);
    expect((mod as any).validateTenantDomain('http://acme.example.com').valid).toBe(false);
  });
});

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

describe('updateApp registry cache invalidation', () => {
  it('clears the per-app registry adapter after API-style app updates', async () => {
    const dataDir = path.join(tmpRoot, 'data');
    await fs.mkdir(path.join(dataDir, 'apps.d'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'apps.d', 'acme.json'), JSON.stringify({
      id: 'acme',
      name: 'Acme',
      domain_template: '*.acme.test',
      registry: { type: 'ghcr', url: 'ghcr.io', repository: 'org/acme', auth: { type: 'token' } },
      services: [{ name: 'web' }],
      default_image_tag: 'latest',
    }));
    await fs.writeFile(path.join(dataDir, 'apps.runtime.json'), JSON.stringify({
      acme: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    }));

    const clearAdapterCache = vi.fn();
    vi.doMock('../config', () => ({ getDataDir: () => dataDir }));
    vi.doMock('../adapters/registry', () => ({ clearAdapterCache }));
    vi.doMock('./fileLock', () => ({ withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn() }));

    const { updateApp } = await import('../services/app');
    await updateApp({ id: 'acme', default_image_tag: 'stable' });

    expect(clearAdapterCache).toHaveBeenCalledWith('acme');
  });
});

describe('notification channel storage', () => {
  it('persists notification channels with 0600 permissions', async () => {
    const dataDir = path.join(tmpRoot, 'data');
    vi.doMock('../config', () => ({
      getDataDir: () => dataDir,
      loadConfig: () => ({ alert_rules: [] }),
    }));

    const { saveNotificationChannels } = await import('../services/alertEngine');
    await saveNotificationChannels([{
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Deploy alerts',
      type: 'webhook',
      enabled: true,
      config: { url: 'https://hooks.example.test/token' },
    } as any]);

    const stat = await fs.stat(path.join(dataDir, 'notification-channels.json'));
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
