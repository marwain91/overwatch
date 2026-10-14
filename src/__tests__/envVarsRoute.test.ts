import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../services/envVars');
  vi.doUnmock('../middleware/requireRole');
});

const regenerate = vi.fn(async (_appId?: string, _opts?: { busy?: string[] }) => 0);
const regenerateTenant = vi.fn(async (..._a: unknown[]) => ({ busy: false }));

async function makeApp(setEnvVar: ReturnType<typeof vi.fn>) {
  vi.doMock('../services/envVars', () => ({
    listEnvVars: vi.fn(async () => [{ key: 'API_TOKEN', value: 's3cret', sensitive: true }]),
    setEnvVar,
    deleteEnvVar: vi.fn(),
    getEffectiveEnvVars: vi.fn(),
    setTenantOverride: vi.fn(),
    deleteTenantOverride: vi.fn(),
    regenerateAllSharedEnvFiles: regenerate,
    regenerateTenantSharedEnv: regenerateTenant,
    generateSharedEnvFile: vi.fn(),
  }));
  vi.doMock('../middleware/requireRole', () => ({ requireRole: () => (_req: any, _res: any, next: any) => next() }));
  const { default: router } = await import('../routes/envVars');
  const app = express();
  app.use(express.json());
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
