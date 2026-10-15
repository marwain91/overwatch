import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tenantAppDefMock } from './tenantAppDefMock';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import { updateDbMethods } from './updateDbMock';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-tenant-rollback-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('dockerode');
  vi.doUnmock('child_process');
  vi.doUnmock('../config');
  vi.doUnmock('../config/loader');
  vi.doUnmock('../adapters/database');
  vi.doUnmock('../services/app');
  vi.doUnmock('../services/envVars');
  vi.doUnmock('../services/docker');
  vi.doUnmock('../services/manifestExtractor');
  vi.doUnmock('../services/tenantAppDef');
  vi.doUnmock('../services/tenantTraefik');
  vi.doUnmock('../middleware/requireRole');
});

function baseConfig() {
  return {
    project: { name: 'Test', prefix: 'test', db_prefix: 'test' },
    database: {
      type: 'mariadb',
      host: 'db',
      port: 3306,
      root_user: 'root',
      root_password_env: 'MYSQL_ROOT_PASSWORD',
      container_name: 'db',
    },
    networking: {
      external_network: 'test-network',
      internal_network_template: '${prefix}-${tenantId}-internal',
      apps_path: '/app/apps',
    },
    traefik: {
      log_level: 'INFO',
      tls_termination: 'upstream',
      upstream_entrypoint: 'web',
    },
  } as any;
}

function baseApp(id = 'customer-portal') {
  return {
    id,
    name: 'Customer Portal',
    domain_template: '*.example.test',
    registry: { type: 'ghcr', url: 'ghcr.io', repository: 'acme/customer-portal', auth: { type: 'token' } },
    services: [
      { name: 'web-api', image_suffix: 'web-api', required: true, ports: { internal: 3000 } },
      { name: 'worker', image_suffix: 'worker', required: false },
    ],
    default_image_tag: 'latest',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as any;
}

describe('tenant lifecycle rollback', () => {
  it('removes the newly-created tenant directory when database creation fails', async () => {
    const appsDir = path.join(tmpRoot, 'apps');
    const db = {
      initialize: vi.fn(async () => undefined),
      getDatabaseName: (id: string) => id,
      databaseExists: vi.fn(async () => false),
      createDatabase: vi.fn(async () => { throw new Error('db create failed'); }),
      dropDatabase: vi.fn(async () => undefined),
    };
    vi.doMock('../services/fileLock', () => ({ withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn(), withTenantLock: <T>(_a: string, _t: string, fn: () => Promise<T>) => fn() }));
    vi.doMock('../config', () => ({
      loadConfig: () => baseConfig(),
      getAppsDir: () => appsDir,
      resolveAppDbPrefix: () => 'test',
    }));
    vi.doMock('../config/loader', () => ({ resolveCertResolver: () => ({ name: 'web', resolver: null }) }));
    vi.doMock('../adapters/database', () => ({ getDatabaseAdapter: () => db }));
    vi.doMock('../services/app', () => ({ getApp: vi.fn(async () => baseApp('customer-portal')), applyApp: vi.fn() }));
    vi.doMock('../services/tenantTraefik', () => ({ readTenantTraefik: vi.fn(async () => undefined), assertTenantDomainAllowed: vi.fn(async () => undefined) }));

    const { createTenant, getTenantPath } = await import('../services/tenant');
    await expect(createTenant({
      appId: 'customer-portal',
      tenantId: 'tenant-one',
      domain: 'tenant-one.example.test',
      imageTag: 'latest',
    })).rejects.toThrow(/db create failed/);

    await expect(fs.access(getTenantPath('customer-portal', 'tenant-one'))).rejects.toThrow();
  });

  it('rejects a disallowed primary domain before any database or directory work', async () => {
    const appsDir = path.join(tmpRoot, 'apps');
    const db = {
      initialize: vi.fn(async () => undefined),
      getDatabaseName: (id: string) => id,
      databaseExists: vi.fn(async () => false),
      createDatabase: vi.fn(async () => undefined),
      dropDatabase: vi.fn(async () => undefined),
    };
    const { ConflictError } = await import('../utils/httpErrors');
    const assertTenantDomainAllowed = vi.fn(async () => { throw new ConflictError('Domain is already used by another tenant'); });
    vi.doMock('../services/fileLock', () => ({ withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn(), withTenantLock: <T>(_a: string, _t: string, fn: () => Promise<T>) => fn() }));
    vi.doMock('../config', () => ({ loadConfig: () => baseConfig(), getAppsDir: () => appsDir, resolveAppDbPrefix: () => 'test' }));
    vi.doMock('../config/loader', () => ({ resolveCertResolver: () => ({ name: 'web', resolver: null }) }));
    vi.doMock('../adapters/database', () => ({ getDatabaseAdapter: () => db }));
    vi.doMock('../services/app', () => ({ getApp: vi.fn(async () => baseApp('customer-portal')), applyApp: vi.fn() }));
    vi.doMock('../services/tenantTraefik', () => ({ readTenantTraefik: vi.fn(async () => undefined), assertTenantDomainAllowed }));

    const { createTenant, getTenantPath } = await import('../services/tenant');
    await expect(createTenant({
      appId: 'customer-portal', tenantId: 'tenant-one', domain: 'taken.example.test', imageTag: 'latest',
    })).rejects.toThrow(/already used/);
    expect(assertTenantDomainAllowed).toHaveBeenCalledWith('customer-portal', 'tenant-one', 'taken.example.test');
    expect(db.createDatabase).not.toHaveBeenCalled();
    await expect(fs.access(getTenantPath('customer-portal', 'tenant-one'))).rejects.toThrow();
  });

  it('restores env, shared env, compose, and tenant app definition when restart fails', async () => {
    const appsDir = path.join(tmpRoot, 'apps');
    const tenantPath = path.join(appsDir, 'customer-portal', 'tenants', 'tenant-one');
    await fs.mkdir(tenantPath, { recursive: true });
    const envPath = path.join(tenantPath, '.env');
    const sharedEnvPath = path.join(tenantPath, 'shared.env');
    const composePath = path.join(tenantPath, 'docker-compose.yml');
    const appDefPath = path.join(tenantPath, 'overwatch-app.json');
    const originalEnv = 'APP_ID=customer-portal\nTENANT_ID=tenant-one\nTENANT_DOMAIN=tenant-one.example.test\nIMAGE_TAG=old\n';
    const originalSharedEnv = 'ORIGINAL_SHARED=1\n';
    const originalCompose = 'services:\n  web-api:\n    image: old\n';
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...staticAppDef } = baseApp('customer-portal');
    void _createdAt; void _updatedAt;
    const originalAppDef = JSON.stringify(staticAppDef, null, 2);
    await fs.writeFile(envPath, originalEnv, { mode: 0o600 });
    await fs.writeFile(sharedEnvPath, originalSharedEnv, { mode: 0o600 });
    await fs.writeFile(composePath, originalCompose);
    await fs.writeFile(appDefPath, originalAppDef);

    vi.doMock('../services/fileLock', () => ({ withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn(), withTenantLock: <T>(_a: string, _t: string, fn: () => Promise<T>) => fn() }));

    vi.doMock('../config', () => ({
      loadConfig: () => baseConfig(),
      getAppsDir: () => appsDir,
      resolveAppDbPrefix: () => 'test',
    }));
    vi.doMock('../config/loader', () => ({ resolveCertResolver: () => ({ name: 'web', resolver: null }) }));
    vi.doMock('../services/app', () => ({
      getApp: vi.fn(async () => baseApp('customer-portal')),
      applyApp: vi.fn(),
    }));
    vi.doMock('../services/envVars', async () => ({
      ...(await vi.importActual<object>('../services/envVars')),
      generateSharedEnvFile: vi.fn(async () => {
        await fs.writeFile(sharedEnvPath, 'NEW_SHARED=1\n', { mode: 0o600 });
      }),
      deleteTenantAllOverrides: vi.fn(),
    }));
    vi.doMock('../services/manifestExtractor', () => ({
      readManifestFromAppImage: vi.fn(async () => null),
      resolveManifestImageRef: vi.fn(() => 'ghcr.io/acme/customer-portal/web-api:new'),
    }));
    vi.doMock('../services/tenantTraefik', () => ({ readTenantTraefik: vi.fn(async () => undefined) }));
    vi.doMock('../adapters/database', () => ({ getDatabaseAdapter: () => updateDbMethods() }));
    vi.doMock('../services/tenantAppDef', () => tenantAppDefMock({
      readTenantAppDef: vi.fn(async () => baseApp('customer-portal')),
      writeTenantAppDef: vi.fn(async (_appId: string, _tenantId: string, appDef: any) => {
        await fs.writeFile(appDefPath, JSON.stringify(appDef, null, 2));
      }),
    }));
    vi.doMock('../services/docker', () => ({ ensureExternalVolumes: vi.fn(async () => undefined) }));
    vi.doMock('child_process', () => ({
      execFile: vi.fn((_cmd: string, args: string[], _opts: unknown, cb: (err: any, stdout: string, stderr: string) => void) => {
        if (args.includes('up')) {
          const err: any = new Error('compose up failed');
          err.stderr = 'Error: restart failed';
          cb(err, '', err.stderr);
          return;
        }
        cb(null, '', '');
      }),
    }));

    const { updateTenant } = await import('../services/tenant');
    await expect(updateTenant('customer-portal', 'tenant-one', 'new')).rejects.toThrow(/restart failed/);

    await expect(fs.readFile(envPath, 'utf-8')).resolves.toBe(originalEnv);
    await expect(fs.readFile(sharedEnvPath, 'utf-8')).resolves.toBe(originalSharedEnv);
    await expect(fs.readFile(composePath, 'utf-8')).resolves.toBe(originalCompose);
    await expect(fs.readFile(appDefPath, 'utf-8')).resolves.toBe(originalAppDef);
  });

  it('uses the requested app registry when a renamed tenant snapshot has a stale id', async () => {
    const appsDir = path.join(tmpRoot, 'apps');
    const tenantPath = path.join(appsDir, 'product', 'tenants', 'daktela');
    await fs.mkdir(tenantPath, { recursive: true });
    const envPath = path.join(tenantPath, '.env');
    const sharedEnvPath = path.join(tenantPath, 'shared.env');
    const composePath = path.join(tenantPath, 'docker-compose.yml');

    await fs.writeFile(envPath, 'APP_ID=hyperproduct\nTENANT_ID=daktela\nTENANT_DOMAIN=product.daktela.com\nIMAGE_TAG=1.2.25\n', { mode: 0o600 });
    await fs.writeFile(sharedEnvPath, 'ORIGINAL_SHARED=1\n', { mode: 0o600 });
    await fs.writeFile(composePath, 'services:\n  backend:\n    image: old\n');

    const globalProduct = {
      ...baseApp('product'),
      name: 'Product',
      domain_template: '*.daktela.com',
      registry: { type: 'ghcr', url: 'ghcr.io', repository: 'jerryminiapps/product', auth: { type: 'token' } },
      services: [
        { name: 'backend', image_suffix: 'backend', required: true, ports: { internal: 3000 } },
        { name: 'frontend', image_suffix: 'frontend', required: true, ports: { internal: 80 } },
      ],
    };
    const staleSnapshot = {
      ...globalProduct,
      id: 'hyperproduct',
      name: 'HyperProduct',
      domain_template: '*.hyperproduct.app',
      registry: { type: 'ghcr', url: 'ghcr.io', repository: 'theopenapps/hyperproduct', auth: { type: 'token' } },
    };

    const { createdAt: _manifestCreatedAt, updatedAt: _manifestUpdatedAt, ...staleManifest } = staleSnapshot;
    void _manifestCreatedAt; void _manifestUpdatedAt;
    const imageManifest = {
      ...staleManifest,
      registry: { ...staleManifest.registry, repository: 'jerryminiapps/product' },
    };
    const readManifestFromAppImage = vi.fn(async () => imageManifest);
    const applyApp = vi.fn(async (def: any) => ({
      result: 'updated',
      app: { ...def, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
      changedKeys: ['id'],
    }));
    const writeTenantAppDef = vi.fn(async () => undefined);
    vi.doMock('../services/fileLock', () => ({ withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn(), withTenantLock: <T>(_a: string, _t: string, fn: () => Promise<T>) => fn() }));
    vi.doMock('../config', () => ({
      loadConfig: () => baseConfig(),
      getAppsDir: () => appsDir,
      resolveAppDbPrefix: () => 'test',
    }));
    vi.doMock('../config/loader', () => ({ resolveCertResolver: () => ({ name: 'web', resolver: null }) }));
    vi.doMock('../services/app', () => ({
      getApp: vi.fn(async (id: string) => id === 'product' ? globalProduct : null),
      applyApp,
    }));
    vi.doMock('../services/envVars', async () => ({
      ...(await vi.importActual<object>('../services/envVars')),
      generateSharedEnvFile: vi.fn(async () => {
        await fs.writeFile(sharedEnvPath, 'NEW_SHARED=1\n', { mode: 0o600 });
      }),
      deleteTenantAllOverrides: vi.fn(),
    }));
    vi.doMock('../services/manifestExtractor', () => ({
      readManifestFromAppImage,
      resolveManifestImageRef: vi.fn(() => 'ghcr.io/jerryminiapps/product/backend:1.2.26'),
    }));
    vi.doMock('../services/tenantTraefik', () => ({ readTenantTraefik: vi.fn(async () => undefined) }));
    vi.doMock('../adapters/database', () => ({ getDatabaseAdapter: () => updateDbMethods() }));
    vi.doMock('../services/tenantAppDef', () => tenantAppDefMock({
      readTenantAppDef: vi.fn(async () => staleSnapshot),
      writeTenantAppDef,
    }));
    vi.doMock('../services/docker', () => ({ ensureExternalVolumes: vi.fn(async () => undefined) }));
    vi.doMock('child_process', () => ({
      execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: any, stdout: string, stderr: string) => void) => {
        cb(null, '', '');
      }),
    }));

    const { updateTenant } = await import('../services/tenant');
    await updateTenant('product', 'daktela', '1.2.26');

    expect(readManifestFromAppImage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'product',
        registry: expect.objectContaining({ repository: 'jerryminiapps/product' }),
      }),
      '1.2.26',
    );
    expect(writeTenantAppDef).toHaveBeenCalledWith(
      'product',
      'daktela',
      expect.objectContaining({
        id: 'product',
        registry: expect.objectContaining({ repository: 'jerryminiapps/product' }),
      }),
    );
    expect(applyApp).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'product',
        registry: expect.objectContaining({ repository: 'jerryminiapps/product' }),
      }),
      expect.stringContaining('manifest:'),
    );
    const compose = await fs.readFile(composePath, 'utf-8');
    const backend = (yaml.load(compose) as any).services.backend;
    expect(backend.image).toBe('ghcr.io/jerryminiapps/product/backend:${IMAGE_TAG:-latest}');
    expect(backend.container_name).toBe('product-daktela-backend');
    expect(compose).not.toContain('theopenapps/hyperproduct');
  });
});

