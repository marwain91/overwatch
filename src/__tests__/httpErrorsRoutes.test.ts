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
  vi.doMock('../config/loader', () => ({
    getAppsDir: () => appsDir,
    resolveCertResolver: () => ({ name: 'web', resolver: null }),
    loadConfig: () => ({ project: { name: 'T', prefix: 'test', db_prefix: 'test' } }),
  }));
  vi.doMock('../services/fileLock', () => ({ withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn(), withTenantLock: <T>(_a: string, _t: string, fn: () => Promise<T>) => fn() }));
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
  it('surfaces connection failures as a fixed 503 instead of a generic 500', async () => {
    vi.doMock('../adapters/database', () => ({
      getDatabaseAdapter: () => ({ getServerInfo: async () => { throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:3306'), { code: 'ECONNREFUSED' }); } }),
    }));
    const router = (await import('../routes/database')).default;
    const app = await mountWith(router, '/database');
    const res = await request(app).get('/database/info');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Database unreachable');
    expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
  });

  it.each([
    [{ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 172.18.0.5:3306' }, 503, 'Database unreachable'],
    [{ code: 'PROTOCOL_CONNECTION_LOST', message: 'Connection lost: 172.18.0.5' }, 503, 'Database unreachable'],
    [{ code: '08006', message: 'connection failure to 172.18.0.5' }, 503, 'Database unreachable'],
    [{ code: 'ER_ACCESS_DENIED_ERROR', message: "Access denied for user 'root'@'172.18.0.3' (using password: YES)" }, 502, 'Database authentication failed'],
    [{ code: '28P01', message: 'password authentication failed for user "postgres"' }, 502, 'Database authentication failed'],
    [{ code: 'ER_PARSE_ERROR', message: "You have an error in your SQL syntax near 'SELECT secret'" }, 502, 'Database query failed'],
    [{ message: 'something odd at 172.18.0.9' }, 502, 'Database query failed'],
  ])('classifies %o without echoing driver text', async (driverErr, status, message) => {
    vi.doMock('../adapters/database', () => ({
      getDatabaseAdapter: () => ({ getServerStats: async () => { throw Object.assign(new Error(driverErr.message), driverErr); } }),
    }));
    const router = (await import('../routes/database')).default;
    const app = await mountWith(router, '/database');
    const res = await request(app).get('/database/stats');
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error: message });
    expect(JSON.stringify(res.body)).not.toMatch(/172\.18|root|postgres|SELECT/);
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

describe('docker CLI failures reach the client as 503/502 through the real handler', () => {
  async function stopWithDockerFailure(stderr: string, exitCode: number | null) {
    const tenantPath = path.join(appsDir, 'acme', 'tenants', 't1');
    await fs.mkdir(tenantPath, { recursive: true });
    await fs.writeFile(path.join(tenantPath, '.env'), 'X=1\n');
    await fs.writeFile(path.join(tenantPath, 'docker-compose.yml'), 'services: {}\n');
    vi.doMock('child_process', async (orig) => {
      const actual: any = await orig();
      const execFile: any = vi.fn((_c: string, _a: string[], _o: any, cb: any) => {
        const err: any = new Error('Command failed');
        err.code = exitCode;
        cb(err, '', stderr);
        return { on() {} };
      });
      return { ...actual, execFile };
    });
    const router = (await import('../routes/tenants')).default;
    const app = await mountWith(router, '/apps/:appId/tenants');
    return request(app).post('/apps/acme/tenants/t1/stop');
  }

  it('an unreachable daemon is a fixed 503 without the CLI stderr', async () => {
    const res = await stopWithDockerFailure('Cannot connect to the Docker daemon at unix:///var/run/docker.sock', 1);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Cannot connect to the Docker daemon' });
  });

  it('any other docker failure is a fixed 502', async () => {
    const res = await stopWithDockerFailure('boom at /srv/apps/acme/tenants/t1', 1);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'Docker command failed' });
    expect(JSON.stringify(res.body)).not.toContain('/srv/apps');
  });
});

describe('PUT tenant traefik validation', () => {
  async function put(body: unknown) {
    await fs.mkdir(path.join(appsDir, 'acme', 'tenants', 't1'), { recursive: true });
    const router = (await import('../routes/tenants')).default;
    const app = await mountWith(router, '/apps/:appId/tenants');
    return request(app).put('/apps/acme/tenants/t1/traefik').send(body as object);
  }

  it('a schema violation is a 400', async () => {
    const res = await put({ host_aliases: 'not-an-array' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^Invalid input/);
  });

  it('a raw label for another tenant\'s router is a 400 naming the label', async () => {
    const res = await put({ raw_labels: { web: { 'traefik.http.routers.acme-t2-web.priority': '1' } } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('acme-t2-web');
  });

  it('an unknown tenant is a 404', async () => {
    const router = (await import('../routes/tenants')).default;
    const app = await mountWith(router, '/apps/:appId/tenants');
    const res = await request(app).put('/apps/acme/tenants/ghost/traefik').send({ host_aliases: [] });
    expect(res.status).toBe(404);
  });
});

