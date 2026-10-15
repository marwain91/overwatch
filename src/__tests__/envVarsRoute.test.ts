import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../services/envVars');
  vi.doUnmock('../services/app');
  vi.doUnmock('../middleware/requireRole');
});

const regenerate = vi.fn(async (_appId?: string, _opts?: { busy?: string[] }) => 0);
const regenerateTenant = vi.fn(async (..._a: unknown[]) => ({ busy: false }));

interface MakeAppOptions {
  role?: 'viewer' | 'editor' | 'admin';
  vars?: Array<{ key: string; value: string; sensitive: boolean }>;
  effective?: Array<{ key: string; value: string; sensitive: boolean; source: string }>;
  services?: Record<string, ReturnType<typeof vi.fn>>;
}

async function makeApp(setEnvVar: ReturnType<typeof vi.fn>, opts: MakeAppOptions = {}) {
  vi.doMock('../services/envVars', () => ({
    listEnvVars: vi.fn(async () => opts.vars ?? [{ key: 'API_TOKEN', value: 's3cret', sensitive: true }]),
    setEnvVar,
    deleteEnvVar: vi.fn(),
    getEffectiveEnvVars: vi.fn(async () => opts.effective ?? []),
    setTenantOverride: vi.fn(),
    deleteTenantOverride: vi.fn(),
    regenerateAllSharedEnvFiles: regenerate,
    regenerateTenantSharedEnv: regenerateTenant,
    generateSharedEnvFile: vi.fn(),
    ...opts.services,
  }));
  vi.doMock('../services/app', () => ({
    listApps: vi.fn(async () => [
      { id: 'demo', admin_access: { enabled: true, secret_env: 'DEMO_ADMIN_SECRET' } },
      { id: 'other' },
    ]),
    getApp: vi.fn(),
  }));
  vi.doMock('../middleware/requireRole', () => ({ requireRole: () => (_req: any, _res: any, next: any) => next() }));
  const { default: router } = await import('../routes/envVars');
  const app = express();
  app.use(express.json());
  // Stands in for authMiddleware.
  app.use((_req, res, next) => { res.locals.user = { email: 'u@example.com', role: opts.role ?? 'admin' }; next(); });
  app.use('/api/apps/:appId/env-vars', router);
  return app;
}

describe('POST /api/apps/:appId/env-vars', () => {
  it('keeps an existing secret sensitive when the edit omits the flag', async () => {
    const setEnvVar = vi.fn(async (_appId: string, key: string, value: string, sensitive: boolean) => ({ key, value, sensitive }));
    const app = await makeApp(setEnvVar);

    const res = await request(app)
      .post('/api/apps/demo/env-vars')
      .send({ key: 'API_TOKEN', description: 'rotated description' })
      .expect(200);

    expect(setEnvVar).toHaveBeenCalledWith('demo', 'API_TOKEN', 's3cret', true, 'rotated description');
    expect(res.body.envVar.value).toBe('••••••••');
  });

  it('refuses to unmask a secret without the value being re-entered', async () => {
    const setEnvVar = vi.fn();
    const app = await makeApp(setEnvVar);

    const res = await request(app)
      .post('/api/apps/demo/env-vars')
      .send({ key: 'API_TOKEN', sensitive: false })
      .expect(400);

    expect(res.body.error).toMatch(/re-enter the value/i);
    expect(setEnvVar).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean sensitive flag (falsy values would unmask the secret)', async () => {
    const setEnvVar = vi.fn();
    const app = await makeApp(setEnvVar);

    for (const sensitive of [0, '', 'false']) {
      await request(app).post('/api/apps/demo/env-vars').send({ key: 'API_TOKEN', sensitive }).expect(400);
    }
    expect(setEnvVar).not.toHaveBeenCalled();
  });

  it('rejects wrongly typed fields that would corrupt the env-var stores', async () => {
    const setEnvVar = vi.fn();
    const app = await makeApp(setEnvVar);

    await request(app).post('/api/apps/demo/env-vars').send({ key: 'NEW_VAR', value: 'v', description: 42 }).expect(400);
    await request(app).post('/api/apps/demo/env-vars/tenants/t1/overrides').send({ key: 'NEW_VAR', value: 'v', sensitive: 'yes' }).expect(400);
    expect(setEnvVar).not.toHaveBeenCalled();
  });

  it('stores a null description as absent (the store schema rejects null)', async () => {
    const setEnvVar = vi.fn(async (_appId: string, key: string, value: string, sensitive: boolean) => ({ key, value, sensitive }));
    const app = await makeApp(setEnvVar);

    await request(app).post('/api/apps/demo/env-vars').send({ key: 'NEW_VAR', value: 'v', description: null }).expect(200);
    expect(setEnvVar).toHaveBeenCalledWith('demo', 'NEW_VAR', 'v', false, undefined);
  });

  it('still honours an explicit sensitive flag', async () => {
    const setEnvVar = vi.fn(async (_appId: string, key: string, value: string, sensitive: boolean) => ({ key, value, sensitive }));
    const app = await makeApp(setEnvVar);

    await request(app)
      .post('/api/apps/demo/env-vars')
      .send({ key: 'API_TOKEN', value: 'new', sensitive: false })
      .expect(200);

    expect(setEnvVar).toHaveBeenCalledWith('demo', 'API_TOKEN', 'new', false, undefined);
  });
});

describe('busy tenants are a warning, not a failure', () => {
  const warning = (id: string) => `${id} is busy; its shared.env will be updated when the current operation finishes`;
  const setEnvVar = async (_a: string, key: string, value: string, sensitive: boolean) => ({ key, value, sensitive });

  it('POST /env-vars returns 200 with a warning per busy tenant', async () => {
    regenerate.mockImplementationOnce(async (_a, opts) => { opts?.busy?.push('demo/a', 'demo/b'); return 1; });
    const res = await request(await makeApp(vi.fn(setEnvVar))).post('/api/apps/demo/env-vars').send({ key: 'K', value: 'v' }).expect(200);
    expect(res.body.tenantsAffected).toBe(1);
    expect(res.body.warnings).toEqual([warning('demo/a'), warning('demo/b')]);
  });

  it('omits warnings when nothing was busy', async () => {
    const res = await request(await makeApp(vi.fn(setEnvVar))).post('/api/apps/demo/env-vars').send({ key: 'K', value: 'v' }).expect(200);
    expect(res.body.warnings).toBeUndefined();
  });

  it('DELETE /env-vars/:key returns the warnings too', async () => {
    regenerate.mockImplementationOnce(async (_a, opts) => { opts?.busy?.push('demo/a'); return 0; });
    const res = await request(await makeApp(vi.fn())).delete('/api/apps/demo/env-vars/K').expect(200);
    expect(res.body.warnings).toEqual([warning('demo/a')]);
  });

  it('tenant override set/delete return a warning when the tenant is busy', async () => {
    regenerateTenant.mockResolvedValue({ busy: true });
    const app = await makeApp(vi.fn());
    const set = await request(app).post('/api/apps/demo/env-vars/tenants/a/overrides').send({ key: 'K', value: 'v' }).expect(200);
    expect(set.body.warnings).toEqual([warning('demo/a')]);
    const del = await request(app).delete('/api/apps/demo/env-vars/tenants/a/overrides/K').expect(200);
    expect(del.body.warnings).toEqual([warning('demo/a')]);
  });
});

// shared.env outranks the tenant's .env and image ENV: an editor who could set
// the secret a tenant verifies admin tokens with could sign their own
// {isSystemAdmin:true} token, which only an admin may mint.
describe('admin-only keys (tenant admin-token secrets)', () => {
  const adminOnly = ['AUTH_SERVICE_SECRET', 'DEMO_ADMIN_SECRET', ' AUTH_SERVICE_SECRET'];

  it.each(adminOnly)('an editor cannot set %j globally', async (key) => {
    const setEnvVar = vi.fn();
    const app = await makeApp(setEnvVar, { role: 'editor' });
    const res = await request(app).post('/api/apps/demo/env-vars').send({ key, value: 'known', sensitive: true }).expect(403);
    expect(res.body.error).toMatch(/admin/i);
    expect(setEnvVar).not.toHaveBeenCalled();
  });

  it.each(adminOnly)('an editor cannot set %j as a tenant override', async (key) => {
    const setTenantOverride = vi.fn();
    const app = await makeApp(vi.fn(), { role: 'editor', services: { setTenantOverride } });
    await request(app).post('/api/apps/demo/env-vars/tenants/t1/overrides').send({ key, value: 'known' }).expect(403);
    expect(setTenantOverride).not.toHaveBeenCalled();
  });

  it('an editor cannot delete the global variable or the override', async () => {
    const deleteEnvVar = vi.fn();
    const deleteTenantOverride = vi.fn();
    const app = await makeApp(vi.fn(), { role: 'editor', services: { deleteEnvVar, deleteTenantOverride } });
    await request(app).delete('/api/apps/demo/env-vars/AUTH_SERVICE_SECRET').expect(403);
    await request(app).delete('/api/apps/demo/env-vars/tenants/t1/overrides/DEMO_ADMIN_SECRET').expect(403);
    expect(deleteEnvVar).not.toHaveBeenCalled();
    expect(deleteTenantOverride).not.toHaveBeenCalled();
  });

  // Only reach the tenant's containers, never Overwatch: apps use them for their own S3/OAuth.
  it.each(['LOG_LEVEL', 'AWS_SECRET_ACCESS_KEY', 'GOOGLE_CLIENT_SECRET', 'R2_ACCESS_KEY_ID'])('an editor still writes %s', async (key) => {
    const setEnvVar = vi.fn(async (_a: string, k: string, value: string, sensitive: boolean) => ({ key: k, value, sensitive }));
    const setTenantOverride = vi.fn();
    const deleteEnvVar = vi.fn();
    const app = await makeApp(setEnvVar, { role: 'editor', services: { setTenantOverride, deleteEnvVar } });
    await request(app).post('/api/apps/demo/env-vars').send({ key, value: 'debug' }).expect(200);
    await request(app).post('/api/apps/demo/env-vars/tenants/t1/overrides').send({ key, value: 'info' }).expect(200);
    await request(app).delete(`/api/apps/demo/env-vars/${key}`).expect(200);
    expect(setEnvVar).toHaveBeenCalled();
    expect(setTenantOverride).toHaveBeenCalled();
    expect(deleteEnvVar).toHaveBeenCalled();
  });

  it('an admin can set, override and delete them', async () => {
    const setEnvVar = vi.fn(async (_a: string, key: string, value: string, sensitive: boolean) => ({ key, value, sensitive }));
    const setTenantOverride = vi.fn();
    const deleteEnvVar = vi.fn();
    const app = await makeApp(setEnvVar, { role: 'admin', services: { setTenantOverride, deleteEnvVar } });
    await request(app).post('/api/apps/demo/env-vars').send({ key: 'AUTH_SERVICE_SECRET', value: 'v', sensitive: true }).expect(200);
    await request(app).post('/api/apps/demo/env-vars/tenants/t1/overrides').send({ key: 'DEMO_ADMIN_SECRET', value: 'v' }).expect(200);
    await request(app).delete('/api/apps/demo/env-vars/AUTH_SERVICE_SECRET').expect(200);
    expect(setEnvVar).toHaveBeenCalled();
    expect(setTenantOverride).toHaveBeenCalled();
    expect(deleteEnvVar).toHaveBeenCalled();
  });

  const stored = [
    { key: 'AUTH_SERVICE_SECRET', value: 'plain-but-secret', sensitive: false },
    { key: 'DEMO_ADMIN_SECRET', value: 'also-secret', sensitive: false },
    { key: 'LOG_LEVEL', value: 'info', sensitive: false },
    { key: 'AWS_ACCESS_KEY_ID', value: 'AKIA-plain', sensitive: false },
  ];

  it.each(['viewer', 'editor'] as const)('a %s always sees them masked, whatever their sensitive flag', async (role) => {
    const effective = stored.map(v => ({ ...v, source: 'global' }));
    const app = await makeApp(vi.fn(), { role, vars: stored, effective });
    for (const url of ['/api/apps/demo/env-vars', '/api/apps/demo/env-vars/tenants/t1']) {
      const res = await request(app).get(url).expect(200);
      const byKey = Object.fromEntries(res.body.map((v: any) => [v.key, v]));
      expect(byKey.AUTH_SERVICE_SECRET).toMatchObject({ value: '••••••••', sensitive: true });
      expect(byKey.DEMO_ADMIN_SECRET).toMatchObject({ value: '••••••••', sensitive: true });
      expect(byKey.LOG_LEVEL).toMatchObject({ value: 'info', sensitive: false });
      expect(byKey.AWS_ACCESS_KEY_ID).toMatchObject({ value: 'AKIA-plain', sensitive: false });
    }
  });

  it('an admin sees them as their sensitive flag says', async () => {
    const app = await makeApp(vi.fn(), { role: 'admin', vars: stored });
    const res = await request(app).get('/api/apps/demo/env-vars').expect(200);
    expect(res.body.find((v: any) => v.key === 'AUTH_SERVICE_SECRET').value).toBe('plain-but-secret');
  });
});
