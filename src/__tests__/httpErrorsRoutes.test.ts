import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import express from 'express';
import request from 'supertest';

// Each test dynamically imports the service graph; allow for a loaded CI host.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let tmpRoot: string;
let dataDir: string;
let appsDir: string;

function validApp(id: string) {
  return {
    id, name: id, domain_template: `*.${id}.example`,
    registry: { type: 'ghcr', url: 'ghcr.io', repository: `ns/${id}`, auth: { type: 'token' } },
    services: [{ name: 'web', image_suffix: 'web', ports: { internal: 80 } }],
    default_image_tag: 'latest',
  };
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-http-routes-'));
  dataDir = path.join(tmpRoot, 'data');
  appsDir = path.join(tmpRoot, 'apps');
  await fs.mkdir(path.join(dataDir, 'apps.d'), { recursive: true });
  await fs.mkdir(appsDir, { recursive: true });
  vi.doMock('../config', () => ({
    getDataDir: () => dataDir,
    getAppsDir: () => appsDir,
    loadConfig: () => ({ project: { name: 'T', prefix: 'test', db_prefix: 'test' } }),
    resolveAppDbPrefix: () => 'test',
  }));
  vi.doMock('../config/loader', () => ({ getAppsDir: () => appsDir, resolveCertResolver: () => ({ name: 'web', resolver: null }) }));
  vi.doMock('../services/fileLock', () => ({ withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn() }));
  vi.doMock('../middleware/requireRole', () => ({ requireRole: () => (_req: any, _res: any, next: any) => next() }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  vi.resetModules();
  vi.restoreAllMocks();
  for (const m of ['../config', '../config/loader', '../services/fileLock', '../middleware/requireRole', 'child_process', '../adapters/database', '../services/manifestExtractor']) vi.doUnmock(m);
});

async function mountWith(router: any, mount: string) {
  const { errorHandler } = await import('../middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use(mount, router);
  app.use(errorHandler);
  return app;
}

describe('env var services typed errors', () => {
  it('invalid key is ValidationError; missing var/override is NotFoundError', async () => {
    const { setEnvVar, deleteEnvVar, deleteTenantOverride } = await import('../services/envVars');
    const { ValidationError, NotFoundError } = await import('../utils/httpErrors');
    await expect(setEnvVar('acme', 'bad key!', 'v', false)).rejects.toBeInstanceOf(ValidationError);
    await expect(deleteEnvVar('acme', 'MISSING')).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteTenantOverride('acme', 't1', 'MISSING')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('DELETE /env-vars/:key for an unknown var returns 404 through the real handler', async () => {
    const router = (await import('../routes/envVars')).default;
    const app = await mountWith(router, '/apps/:appId/env-vars');
    const res = await request(app).delete('/apps/acme/env-vars/MISSING');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('MISSING');
  });
});

describe('backup and snapshot services typed errors', () => {
  it('initializeRepository: unknown app is NotFoundError, backup disabled is ValidationError', async () => {
    const { createApp } = await import('../services/app');
    const { initializeRepository } = await import('../services/backup');
    const { ValidationError, NotFoundError } = await import('../utils/httpErrors');
    await expect(initializeRepository('ghost')).rejects.toBeInstanceOf(NotFoundError);
    await createApp(validApp('acme') as any);
    await expect(initializeRepository('acme')).rejects.toBeInstanceOf(ValidationError);
  });

  it('restoreSnapshot with an unknown name is a NotFoundError', async () => {
    const mod: any = await import('../services/configSnapshots');
    const fn = mod.restoreSnapshot || mod.restoreConfigSnapshot;
    expect(fn).toBeTypeOf('function');
    const { NotFoundError } = await import('../utils/httpErrors');
    await expect(fn('nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('database routes', () => {
  it('surfaces driver failures as an exposed 502 instead of a generic 500', async () => {
    vi.doMock('../adapters/database', () => ({
      getDatabaseAdapter: () => ({ getServerInfo: async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:3306'); } }),
    }));
    const router = (await import('../routes/database')).default;
    const app = await mountWith(router, '/database');
    const res = await request(app).get('/database/info');
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('ECONNREFUSED');
  });
});

describe('exposed 5xx from a service reaches the client through the real handler', () => {
  it('PATCH tenant: compose pull failure keeps its message', async () => {
    const tenantPath = path.join(appsDir, 'acme', 'tenants', 't1');
    await fs.mkdir(tenantPath, { recursive: true });
    await fs.writeFile(path.join(tenantPath, '.env'), 'X=1\n');
    await fs.writeFile(path.join(tenantPath, 'docker-compose.yml'), 'services: {}\n');
    const failure: any = new Error('pull access denied for ns/acme-web');
    failure.stderr = 'pull access denied for ns/acme-web';
    vi.doMock('child_process', async (orig) => {
      const actual: any = await orig();
      const execFile: any = vi.fn((_c: string, _a: string[], optsOrCb: any, maybeCb?: any) => {
        const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
        cb(failure, '', failure.stderr);
      });
      execFile[(await import('util')).promisify.custom] = (..._a: any[]) => Promise.reject(failure);
      return { ...actual, execFile };
    });
    vi.doMock('../services/manifestExtractor', () => ({
      readManifestFromAppImage: async () => null,
      resolveManifestImageRef: () => 'x',
    }));
    const { createApp } = await import('../services/app');
    await createApp(validApp('acme') as any);
    const { writeTenantAppDef } = await import('../services/tenantAppDef');
    const { getApp } = await import('../services/app');
    await writeTenantAppDef('acme', 't1', (await getApp('acme')) as any);
    const router = (await import('../routes/tenants')).default;
    const app = await mountWith(router, '/apps/:appId/tenants');
    const res = await request(app).patch('/apps/acme/tenants/t1').send({ imageTag: 'v2' });
    expect(res.status).toBe(500);
    expect(res.body.error).not.toBe('Internal server error');
    expect(res.body.error).toContain('pull access denied');
  });
});
