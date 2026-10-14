import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const config = { database: { root_password_env: 'DB_ROOT_PW' } } as any;

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock('../services/app');
  vi.doUnmock('../services/docker');
  vi.doUnmock('../services/tenant');
  vi.doUnmock('../services/traefikConfig');
  vi.doUnmock('../middleware/requireRole');
  vi.doUnmock('../config/loader');
  delete process.env.MY_TENANT_ADMIN_SECRET;
});

describe('isReservedSecretEnv', () => {
  it('reserves Overwatch core secrets and the configured DB root password env', async () => {
    const { isReservedSecretEnv } = await import('../utils/reservedEnv');
    for (const n of ['JWT_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'RESTIC_PASSWORD', 'R2_SECRET_ACCESS_KEY', 'AWS_SECRET_ACCESS_KEY', 'GHCR_TOKEN', 'DB_ROOT_PW']) {
      expect(isReservedSecretEnv(n, config), n).toBe(true);
    }
  });

  it('does not reserve AUTH_SERVICE_SECRET or ordinary names', async () => {
    const { isReservedSecretEnv } = await import('../utils/reservedEnv');
    for (const n of ['AUTH_SERVICE_SECRET', 'MY_TENANT_ADMIN_SECRET', 'GITLAB_TOKEN']) {
      expect(isReservedSecretEnv(n, config), n).toBe(false);
    }
  });

  it('still applies the static list when config is unavailable', async () => {
    const { isReservedSecretEnv } = await import('../utils/reservedEnv');
    expect(isReservedSecretEnv('JWT_SECRET', null)).toBe(true);
    expect(isReservedSecretEnv('MYSQL_ROOT_PASSWORD', null)).toBe(true);
  });
});

describe('loadConfigOrNull', () => {
  it('returns the loaded config', async () => {
    vi.doMock('../config/loader', () => ({ loadConfig: () => config }));
    const { loadConfigOrNull } = await import('../utils/reservedEnv');
    expect(loadConfigOrNull()).toBe(config);
  });

  it('returns null instead of throwing when the config cannot be loaded', async () => {
    vi.doMock('../config/loader', () => ({ loadConfig: () => { throw new Error('no overwatch.yaml'); } }));
    const { loadConfigOrNull, isReservedSecretEnv } = await import('../utils/reservedEnv');
    expect(loadConfigOrNull()).toBeNull();
    // The static list still applies with a null config.
    expect(isReservedSecretEnv('JWT_SECRET', loadConfigOrNull())).toBe(true);
  });
});

describe('POST /:tenantId/access-token', () => {
  async function makeApp(secretEnv: string) {
    vi.doMock('../middleware/requireRole', () => ({ requireRole: () => (_q: any, _r: any, n: any) => n() }));
    vi.doMock('../config/loader', () => ({ loadConfig: () => config }));
    vi.doMock('../services/app', () => ({
      getApp: vi.fn(async () => ({ id: 'demo', name: 'demo', admin_access: { enabled: true, secret_env: secretEnv } })),
    }));
    vi.doMock('../services/docker', () => ({
      getTenantInfo: vi.fn(async () => ({ domain: 'a.example.com' })),
      listTenants: vi.fn(), startTenant: vi.fn(), stopTenant: vi.fn(), restartTenant: vi.fn(),
    }));
    vi.doMock('../services/tenant', () => ({ createTenant: vi.fn(), deleteTenant: vi.fn(), updateTenant: vi.fn(), validateImageTag: vi.fn() }));
    vi.doMock('../services/traefikConfig', () => ({ getTenantTraefik: vi.fn(), updateTenantTraefik: vi.fn() }));
    const { default: router } = await import('../routes/tenants');
    const app = express();
    app.use(express.json());
    app.use('/api/apps/:appId/tenants', router);
    const { errorHandler } = await import('../middleware/errorHandler');
    app.use(errorHandler);
    return app;
  }

  it('refuses to mint when secret_env is JWT_SECRET, without signing', async () => {
    process.env.JWT_SECRET = 'x'.repeat(40);
    const app = await makeApp('JWT_SECRET');
    const res = await request(app).post('/api/apps/demo/tenants/acme/access-token').expect(400);
    expect(res.body.error).toMatch(/reserved/i);
    expect(res.body.token).toBeUndefined();
  });

  it('mints with a normal secret_env', async () => {
    process.env.MY_TENANT_ADMIN_SECRET = 'tenant-secret';
    const app = await makeApp('MY_TENANT_ADMIN_SECRET');
    const res = await request(app).post('/api/apps/demo/tenants/acme/access-token').expect(200);
    expect(res.body.token).toBeTruthy();
  });
});

describe('registry adapter env names', () => {
  const mk = (auth: Record<string, string>) => ({
    id: 'demo',
    registry: { type: 'gitlab', url: 'registry.example.com', repository: 'g/p', auth: { type: 'token', ...auth } },
  }) as any;

  it('refuses token_env / username_env naming a reserved env', async () => {
    vi.doMock('../config/loader', () => ({ loadConfig: () => config }));
    const { getRegistryAdapterForApp, clearAdapterCache } = await import('../adapters/registry');
    clearAdapterCache();
    expect(() => getRegistryAdapterForApp(mk({ token_env: 'JWT_SECRET' }))).toThrow(/reserved/i);
    expect(() => getRegistryAdapterForApp(mk({ username_env: 'DB_ROOT_PW' }))).toThrow(/reserved/i);
  });

  it('allows normal names and the documented GHCR_TOKEN default', async () => {
    vi.doMock('../config/loader', () => ({ loadConfig: () => config }));
    const { getRegistryAdapterForApp, clearAdapterCache } = await import('../adapters/registry');
    clearAdapterCache();
    expect(() => getRegistryAdapterForApp(mk({ token_env: 'GITLAB_TOKEN' }))).not.toThrow();
    clearAdapterCache();
    expect(() => getRegistryAdapterForApp(mk({ token_env: 'GHCR_TOKEN', username_env: 'GHCR_USERNAME' }))).not.toThrow();
  });
});
