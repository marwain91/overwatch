import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../services/envVars');
  vi.doUnmock('../middleware/requireRole');
});

async function makeApp(setEnvVar: ReturnType<typeof vi.fn>) {
  vi.doMock('../services/envVars', () => ({
    listEnvVars: vi.fn(async () => [{ key: 'API_TOKEN', value: 's3cret', sensitive: true }]),
    setEnvVar,
    deleteEnvVar: vi.fn(),
    getEffectiveEnvVars: vi.fn(),
    setTenantOverride: vi.fn(),
    deleteTenantOverride: vi.fn(),
    regenerateAllSharedEnvFiles: vi.fn(async () => 0),
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
