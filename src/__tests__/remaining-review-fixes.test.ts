import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import * as http from 'http';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-remaining-fixes-'));
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

async function requestApp(app: express.Express, method: string, route: string): Promise<{ status: number; body: any }> {
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind to a port');
    const res = await fetch(`http://127.0.0.1:${address.port}${route}`, { method, headers: { connection: 'close' } });
    return { status: res.status, body: await res.json() };
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
}

describe('container ownership labels and scoped operations', () => {
  it('adds Overwatch ownership labels to every generated tenant service', async () => {
    const { generateComposeFile } = await import('../services/composeGenerator');

    const yml = generateComposeFile({
      app: baseApp('customer-portal'),
      tenantId: 'tenant-one',
      domain: 'tenant-one.example.test',
      config: baseConfig(),
    });

    expect(yml).toContain('      - "com.overwatch.managed=true"');
    expect(yml).toContain('      - "com.overwatch.app-id=customer-portal"');
    expect(yml).toContain('      - "com.overwatch.tenant-id=tenant-one"');
    expect(yml).toContain('      - "com.overwatch.service=web-api"');
    expect(yml).toContain('      - "com.overwatch.service=worker"');
  }, 30000);

  it('discovers hyphenated app and tenant ids from labels instead of dashed names', async () => {
    vi.doMock('dockerode', () => ({
      default: class DockerMock {
        async listContainers() {
          return [{
            Id: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
            Names: ['/compose-generated-name'],
            Status: 'Up 1 minute',
            State: 'running',
            Image: 'ghcr.io/acme/customer-portal/web-api:latest',
            Created: 1760000000,
            Labels: {
              'com.overwatch.managed': 'true',
              'com.overwatch.app-id': 'customer-portal',
              'com.overwatch.tenant-id': 'tenant-one',
              'com.overwatch.service': 'web-api',
            },
          }];
        }
      },
    }));
    vi.doMock('../services/app', () => ({ listApps: vi.fn(async () => [baseApp('customer-portal')]) }));

    const { listContainers } = await import('../services/docker');
    await expect(listContainers()).resolves.toEqual([expect.objectContaining({
      id: 'abcdef123456',
      appId: 'customer-portal',
      tenantId: 'tenant-one',
      service: 'web-api',
    })]);
  });

  it('refuses logs for Docker ids not returned by managed container discovery', async () => {
    const getContainerLogs = vi.fn(async () => 'secret logs');
    vi.doMock('../services/docker', () => ({
      listContainers: vi.fn(async () => []),
      getContainerLogs,
      restartContainer: vi.fn(),
      listTenants: vi.fn(async () => []),
      extractContainerInfo: vi.fn(() => null),
    }));
    vi.doMock('../middleware/requireRole', () => ({ requireRole: () => (_req: any, _res: any, next: any) => next() }));

    const { default: statusRouter } = await import('../routes/status');
    const app = express();
    app.use('/api/status', statusRouter);

    const response = await requestApp(app, 'GET', '/api/status/containers/abcdef123456/logs');
    expect(response.status).toBe(404);
    expect(getContainerLogs).not.toHaveBeenCalled();
  });

  it('refuses restart for Docker ids not returned by managed container discovery', async () => {
    const restartContainer = vi.fn(async () => undefined);
    vi.doMock('../services/docker', () => ({
      listContainers: vi.fn(async () => []),
      getContainerLogs: vi.fn(),
      restartContainer,
      listTenants: vi.fn(async () => []),
      extractContainerInfo: vi.fn(() => null),
    }));
    vi.doMock('../middleware/requireRole', () => ({ requireRole: () => (_req: any, _res: any, next: any) => next() }));

    const { default: statusRouter } = await import('../routes/status');
    const app = express();
    app.use('/api/status', statusRouter);

    const response = await requestApp(app, 'POST', '/api/status/containers/abcdef123456/restart');
    expect(response.status).toBe(404);
    expect(restartContainer).not.toHaveBeenCalled();
  });
});

describe('tenant lifecycle rollback', () => {
  it('removes the newly-created tenant directory when database creation fails', async () => {
    const appsDir = path.join(tmpRoot, 'apps');
    const db = {
      initialize: vi.fn(async () => undefined),
      createDatabase: vi.fn(async () => { throw new Error('db create failed'); }),
      dropDatabase: vi.fn(async () => undefined),
    };
    vi.doMock('../config', () => ({
      loadConfig: () => baseConfig(),
      getAppsDir: () => appsDir,
      resolveAppDbPrefix: () => 'test',
    }));
    vi.doMock('../config/loader', () => ({ resolveCertResolver: () => ({ name: 'web', resolver: null }) }));
    vi.doMock('../adapters/database', () => ({ getDatabaseAdapter: () => db }));
    vi.doMock('../services/app', () => ({ getApp: vi.fn(async () => baseApp('customer-portal')), applyApp: vi.fn() }));

    const { createTenant, getTenantPath } = await import('../services/tenant');
    await expect(createTenant({
      appId: 'customer-portal',
      tenantId: 'tenant-one',
      domain: 'tenant-one.example.test',
      imageTag: 'latest',
    })).rejects.toThrow(/db create failed/);

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
    vi.doMock('../services/envVars', () => ({
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
    vi.doMock('../services/tenantAppDef', () => ({
      readTenantAppDef: vi.fn(async () => baseApp('customer-portal')),
      writeTenantAppDef: vi.fn(async (_appId: string, _tenantId: string, appDef: any) => {
        await fs.writeFile(appDefPath, JSON.stringify(appDef, null, 2));
      }),
    }));
    vi.doMock('../services/docker', () => ({ ensureExternalVolumes: vi.fn(async () => undefined) }));
    vi.doMock('child_process', () => ({
      execFile: vi.fn((_cmd: string, args: string[], cb: (err: any, stdout: string, stderr: string) => void) => {
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
    vi.doMock('../services/envVars', () => ({
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
    vi.doMock('../services/tenantAppDef', () => ({
      readTenantAppDef: vi.fn(async () => staleSnapshot),
      writeTenantAppDef,
    }));
    vi.doMock('../services/docker', () => ({ ensureExternalVolumes: vi.fn(async () => undefined) }));
    vi.doMock('child_process', () => ({
      execFile: vi.fn((_cmd: string, _args: string[], cb: (err: any, stdout: string, stderr: string) => void) => {
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
    expect(compose).toContain('image: ghcr.io/jerryminiapps/product/backend:${IMAGE_TAG:-latest}');
    expect(compose).toContain('container_name: product-daktela-backend');
    expect(compose).not.toContain('theopenapps/hyperproduct');
  });
});

describe('deployment and image build hardening', () => {
  it('builds the server from source in the Dockerfile instead of copying checked-in dist', async () => {
    const dockerfile = await fs.readFile(path.join(process.cwd(), 'Dockerfile'), 'utf-8');
    expect(dockerfile).toContain('FROM node:26-alpine AS server-build');
    expect(dockerfile).toContain('RUN npm run build');
    expect(dockerfile).toContain('COPY --from=server-build /app/dist ./dist');
    expect(dockerfile).not.toMatch(/^COPY dist\/ .*dist/m);
  });

  it('keeps generated and runtime-heavy paths out of Docker build context', async () => {
    const dockerignore = await fs.readFile(path.join(process.cwd(), '.dockerignore'), 'utf-8');
    expect(dockerignore).toMatch(/^node_modules\/?$/m);
    expect(dockerignore).toMatch(/^dist\/?$/m);
    expect(dockerignore).toMatch(/^data\/?$/m);
    expect(dockerignore).toMatch(/^tenants\/?$/m);
    expect(dockerignore).toMatch(/^\.git\/?$/m);
  });

  it('uses directory mounts for runtime state and does not publish the admin port publicly', async () => {
    const compose = await fs.readFile(path.join(process.cwd(), 'docker-compose.yml'), 'utf-8');
    expect(compose).toContain('./data:/app/data');
    expect(compose).toContain('./apps:/app/apps');
    expect(compose).not.toMatch(/\.\/data\/audit\.log:\/app\/data\/audit\.log/);
    expect(compose).not.toMatch(/\.\/data\/notification-channels\.json:\/app\/data\/notification-channels\.json/);
    expect(compose).not.toMatch(/-\s+"?3002:3002"?/);
  });

  it('defaults proxy trust to one hop and supports explicit operator overrides', async () => {
    const { resolveTrustProxySetting } = await import('../utils/proxyTrust');
    expect(resolveTrustProxySetting({})).toBe(1);
    expect(resolveTrustProxySetting({ OVERWATCH_TRUST_PROXY: '0' })).toBe(false);
    expect(resolveTrustProxySetting({ OVERWATCH_TRUST_PROXY: 'false' })).toBe(false);
    expect(resolveTrustProxySetting({ OVERWATCH_TRUST_PROXY: '1' })).toBe(1);
    expect(resolveTrustProxySetting({ OVERWATCH_TRUST_PROXY: '172.18.0.0/16' })).toBe('172.18.0.0/16');
    expect(resolveTrustProxySetting({ OVERWATCH_TRUST_PROXY: 'loopback, linklocal, uniquelocal' }))
      .toBe('loopback, linklocal, uniquelocal');
  });

  it('wires Express trust proxy through the proxy trust resolver', async () => {
    const index = await fs.readFile(path.join(process.cwd(), 'src/index.ts'), 'utf-8');
    expect(index).toContain('resolveTrustProxySetting');
    expect(index).not.toContain("app.set('trust proxy', 1)");
  });

  it('repairs stray bind-mount directories where files are expected', async () => {
    const dataDir = path.join(tmpRoot, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    // Simulate Docker auto-creating bind targets as empty directories.
    await fs.mkdir(path.join(dataDir, 'audit.log'));
    await fs.mkdir(path.join(dataDir, 'notification-channels.json'));
    // And one with content that must NOT be removed silently.
    const stranded = path.join(dataDir, 'tenant-env-overrides.json');
    await fs.mkdir(stranded);
    await fs.writeFile(path.join(stranded, 'something'), 'do not delete me');

    const { repairBindMountedDataFiles } = await import('../services/envVars');
    const result = await repairBindMountedDataFiles(dataDir);

    expect(result.repaired).toBe(2);
    expect(result.stranded).toEqual([stranded]);
    await expect(fs.stat(path.join(dataDir, 'audit.log'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(dataDir, 'notification-channels.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    // Stranded dir is left intact for operator inspection.
    await expect(fs.readFile(path.join(stranded, 'something'), 'utf-8')).resolves.toBe('do not delete me');
  });
});
