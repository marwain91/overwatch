import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import express from 'express';
import request from 'supertest';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let tmpRoot: string;
let tagsImpl: (app: unknown) => Promise<string[]>;

function validApp(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, name: id, domain_template: `*.${id}.example`,
    registry: { type: 'ghcr', url: 'ghcr.io', repository: `ns/${id}`, auth: { type: 'token' } },
    services: [{ name: 'web', image_suffix: 'web', ports: { internal: 80 } }],
    default_image_tag: 'latest',
    ...extra,
  };
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-apps-route-'));
  const dataDir = path.join(tmpRoot, 'data');
  const appsDir = path.join(tmpRoot, 'apps');
  await fs.mkdir(path.join(dataDir, 'apps.d'), { recursive: true });
  await fs.mkdir(appsDir, { recursive: true });
  tagsImpl = async () => [];
  vi.doMock('../config', () => ({
    getDataDir: () => dataDir,
    getAppsDir: () => appsDir,
    loadConfig: () => ({ project: { name: 'T', prefix: 'test', db_prefix: 'test' } }),
    resolveAppDbPrefix: () => 'test',
  }));
  vi.doMock('../config/loader', () => ({ getAppsDir: () => appsDir, resolveCertResolver: () => ({ name: 'web', resolver: null }) }));
  vi.doMock('../services/fileLock', () => ({ withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn() }));
  vi.doMock('../middleware/requireRole', () => ({ requireRole: () => (_req: any, _res: any, next: any) => next() }));
  vi.doMock('../adapters/registry', () => ({
    getImageTagsForApp: (app: unknown) => tagsImpl(app),
    clearAdapterCache: vi.fn(),
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  vi.resetModules();
  vi.restoreAllMocks();
  for (const m of ['../config', '../config/loader', '../services/fileLock', '../middleware/requireRole', '../adapters/registry']) vi.doUnmock(m);
});

async function mount() {
  const { errorHandler } = await import('../middleware/errorHandler');
  const { default: appsRouter } = await import('../routes/apps');
  const { default: tenantsRouter } = await import('../routes/tenants');
  const app = express();
  app.use(express.json());
  app.use('/api/apps', appsRouter);
  app.use('/api/apps/:appId/tenants', tenantsRouter);
  app.use(errorHandler);
  return app;
}

describe('PUT /api/apps/:appId', () => {
  it('rejects an invalid body with 400 and field errors, leaving the app untouched', async () => {
    const app = await mount();
    await request(app).post('/api/apps').send(validApp('demo')).expect(201);

    const res = await request(app)
      .put('/api/apps/demo')
      .send({ name: 123, services: 'not-an-array' })
      .expect(400);
    expect(res.body.error).toMatch(/name/);
    expect(res.body.error).toMatch(/services/);

    const after = await request(app).get('/api/apps/demo').expect(200);
    expect(after.body.name).toBe('demo');
  });

  it('validates at the route: updateApp never sees an invalid body, and only schema fields reach it', async () => {
    const updateSpy = vi.fn(async (input: any) => input);
    vi.doMock('../services/app', async () => ({
      ...(await vi.importActual<any>('../services/app')),
      updateApp: updateSpy,
    }));
    try {
      const app = await mount();
      await request(app).put('/api/apps/demo').send({ default_image_tag: 42 }).expect(400);
      expect(updateSpy).not.toHaveBeenCalled();

      await request(app).put('/api/apps/demo')
        .send({ name: 'renamed', id: 'other', createdAt: '1999-01-01T00:00:00.000Z', bogus: true })
        .expect(200);
      expect(updateSpy).toHaveBeenCalledWith({ id: 'demo', name: 'renamed' });
    } finally {
      vi.doUnmock('../services/app');
    }
  });

  it('persists admin_access.enabled=false and refuses token minting afterwards', async () => {
    const app = await mount();
    await request(app).post('/api/apps').send(validApp('demo', {
      admin_access: { enabled: true, secret_env: 'AUTH_SERVICE_SECRET' },
    })).expect(201);

    await request(app).put('/api/apps/demo')
      .send({ admin_access: { enabled: false, secret_env: 'AUTH_SERVICE_SECRET' } })
      .expect(200);

    const stored = await request(app).get('/api/apps/demo').expect(200);
    expect(stored.body.admin_access.enabled).toBe(false);

    const mint = await request(app).post('/api/apps/demo/tenants/t1/access-token').expect(400);
    expect(mint.body.error).toMatch(/not enabled/i);
  });

  it('persists backup.enabled=false', async () => {
    const app = await mount();
    await request(app).post('/api/apps').send(validApp('demo', { backup: { enabled: true, provider: 's3' } })).expect(201);
    await request(app).put('/api/apps/demo').send({ backup: { enabled: false, provider: 's3' } }).expect(200);
    const stored = await request(app).get('/api/apps/demo').expect(200);
    expect(stored.body.backup.enabled).toBe(false);
  });
});

describe('service names on the write path', () => {
  it.each(['web"x', 'we$b', 'Web', 'web_api', 'a\nb'])('POST and PUT reject the service name %j with 400', async (name) => {
    const app = await mount();
    const bad = { services: [{ name, image_suffix: 'web', ports: { internal: 80 } }] };
    const post = await request(app).post('/api/apps').send(validApp('demo', bad)).expect(400);
    expect(post.body.error).toMatch(/service name/i);
    await request(app).post('/api/apps').send(validApp('demo')).expect(201);
    await request(app).put('/api/apps/demo').send(bad).expect(400);
  });

  it('accepts slug-style service names', async () => {
    const app = await mount();
    await request(app).post('/api/apps').send(validApp('demo', {
      services: [{ name: 'web-api', image_suffix: 'web' }, { name: 'w2', image_suffix: 'w' }],
    })).expect(201);
  });
});

describe('GET /api/apps/:appId/tags', () => {
  const cases: Array<[string, Error, RegExp]> = [
    ['authentication', new Error('GitHub API denied access (HTTP 403). GHCR_TOKEN needs the repo scope for ns/demo.'), /authentication failed/i],
    ['missing token', new Error('GHCR auth not configured'), /authentication failed/i],
    ['not found', new Error('GitHub repository ns/demo not found or not accessible to the configured credentials.'), /repository not found/i],
    ['unreachable', Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), /unreachable/i],
    ['other', new Error('GitHub tags API failed (HTTP 502).'), /failed to list tags/i],
  ];

  for (const [label, err, expected] of cases) {
    it(`classifies ${label} errors without leaking the raw message`, async () => {
      const app = await mount();
      await request(app).post('/api/apps').send(validApp('demo')).expect(201);
      tagsImpl = async () => { throw err; };

      const res = await request(app).get('/api/apps/demo/tags').expect(200);
      expect(res.body.tags).toEqual([]);
      expect(res.body.error).toMatch(expected);
      expect(res.body.error).not.toContain('GHCR_TOKEN');
      expect(res.body.error).not.toContain('ns/demo');
      expect(res.body.error).not.toContain('ECONNREFUSED');
    });
  }
});

describe('health check durations on the write path', () => {
  const withHc = (hc: Record<string, unknown>) => validApp('demo', {
    services: [{ name: 'web', image_suffix: 'web', ports: { internal: 80 }, health_check: { type: 'http', ...hc } }],
  });

  it('POST and PUT reject an invalid interval / start_period with 400', async () => {
    const app = await mount();
    const bad = await request(app).post('/api/apps').send(withHc({ interval: 'soon' })).expect(400);
    expect(bad.body.error).toMatch(/health_check\.interval/);
    await request(app).post('/api/apps').send(withHc({ start_period: '30' })).expect(400);

    await request(app).post('/api/apps').send(withHc({ interval: '1m30s', start_period: '10s' })).expect(201);
    const put = await request(app).put('/api/apps/demo').send({
      services: [{ name: 'web', image_suffix: 'web', health_check: { type: 'http', interval: '5 minutes' } }],
    }).expect(400);
    expect(put.body.error).toMatch(/health_check\.interval/);
  });
});
