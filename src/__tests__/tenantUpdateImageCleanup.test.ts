import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

/** execFile mock with Node's `(cmd, args, opts, cb)` signature, as runDocker calls it. */
function withPromisify(
  mock: (cmd: string, args: string[], cb: (err: any, stdout: string, stderr: string) => void) => void,
) {
  return vi.fn((cmd: string, args: string[], _opts: unknown, cb: (err: any, stdout: string, stderr: string) => void) => {
    mock(cmd, args, cb);
    return { on: () => {} };
  });
}


let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-tenant-image-cleanup-'));
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

describe('tenant update image cleanup', () => {
  it('removes image tags the regenerated compose no longer references', async () => {
    const appsDir = path.join(tmpRoot, 'apps');
    const tenantPath = path.join(appsDir, 'customer-portal', 'tenants', 'tenant-one');
    await fs.mkdir(tenantPath, { recursive: true });
    const envPath = path.join(tenantPath, '.env');
    const sharedEnvPath = path.join(tenantPath, 'shared.env');
    const composePath = path.join(tenantPath, 'docker-compose.yml');

    await fs.writeFile(
      envPath,
      'APP_ID=customer-portal\nTENANT_ID=tenant-one\nTENANT_DOMAIN=tenant-one.example.test\nIMAGE_TAG=1.0.0\n',
      { mode: 0o600 },
    );
    await fs.writeFile(sharedEnvPath, 'SHARED=1\n', { mode: 0o600 });
    await fs.writeFile(composePath, 'services:\n  web-api:\n    image: ghcr.io/acme/customer-portal/web-api:1.0.0\n');

    vi.doMock('../services/fileLock', () => ({ withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn(), withTenantLock: <T>(_a: string, _t: string, fn: () => Promise<T>) => fn() }));

    vi.doMock('../config', () => ({
      loadConfig: () => baseConfig(),
      getAppsDir: () => appsDir,
      resolveAppDbPrefix: () => 'test',
    }));
    vi.doMock('../config/loader', () => ({ resolveCertResolver: () => ({ name: 'web', resolver: null }) }));
    vi.doMock('../services/app', () => ({
      getApp: vi.fn(async () => baseApp('customer-portal')),
      applyApp: vi.fn(async (def: any) => ({ result: 'noop', app: def, changedKeys: [] })),
    }));
    vi.doMock('../services/envVars', () => ({
      generateSharedEnvFile: vi.fn(async () => {
        await fs.writeFile(sharedEnvPath, 'SHARED=2\n', { mode: 0o600 });
      }),
      deleteTenantAllOverrides: vi.fn(),
    }));
    vi.doMock('../services/manifestExtractor', () => ({
      readManifestFromAppImage: vi.fn(async () => null),
      resolveManifestImageRef: vi.fn(() => 'ghcr.io/acme/customer-portal/web-api:1.1.0'),
    }));
    vi.doMock('../services/tenantTraefik', () => ({ readTenantTraefik: vi.fn(async () => undefined) }));
    vi.doMock('../services/tenantAppDef', () => ({
      readTenantAppDef: vi.fn(async () => baseApp('customer-portal')),
      writeTenantAppDef: vi.fn(async () => undefined),
    }));
    vi.doMock('../services/docker', () => ({ ensureExternalVolumes: vi.fn(async () => undefined) }));

    // `config --images` is called twice: once before mutations (returns old
    // image), once after restart (returns new image). Other compose commands
    // (pull, up) and `rmi` succeed.
    let configCalls = 0;
    const rmiCalls: string[] = [];
    vi.doMock('child_process', () => ({
      execFile: withPromisify((_cmd, args, cb) => {
        if (args.includes('config') && args.includes('--images')) {
          const out = configCalls++ === 0
            ? 'ghcr.io/acme/customer-portal/web-api:1.0.0\n'
            : 'ghcr.io/acme/customer-portal/web-api:1.1.0\n';
          cb(null, out, '');
          return;
        }
        if (args[0] === 'rmi') {
          rmiCalls.push(args[1]);
          cb(null, '', '');
          return;
        }
        cb(null, '', '');
      }),
    }));

    const { updateTenant } = await import('../services/tenant');
    await updateTenant('customer-portal', 'tenant-one', '1.1.0');

    expect(configCalls).toBe(2);
    expect(rmiCalls).toEqual(['ghcr.io/acme/customer-portal/web-api:1.0.0']);
  });

  it('skips cleanup when the compose file still references the same image ref', async () => {
    const appsDir = path.join(tmpRoot, 'apps');
    const tenantPath = path.join(appsDir, 'customer-portal', 'tenants', 'tenant-one');
    await fs.mkdir(tenantPath, { recursive: true });
    const envPath = path.join(tenantPath, '.env');
    const sharedEnvPath = path.join(tenantPath, 'shared.env');
    const composePath = path.join(tenantPath, 'docker-compose.yml');

    await fs.writeFile(envPath, 'APP_ID=customer-portal\nTENANT_ID=tenant-one\nTENANT_DOMAIN=t.example.test\nIMAGE_TAG=latest\n', { mode: 0o600 });
    await fs.writeFile(sharedEnvPath, 'SHARED=1\n', { mode: 0o600 });
    await fs.writeFile(composePath, 'services:\n  web-api:\n    image: ghcr.io/acme/customer-portal/web-api:latest\n');

    vi.doMock('../services/fileLock', () => ({ withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn(), withTenantLock: <T>(_a: string, _t: string, fn: () => Promise<T>) => fn() }));

    vi.doMock('../config', () => ({
      loadConfig: () => baseConfig(),
      getAppsDir: () => appsDir,
      resolveAppDbPrefix: () => 'test',
    }));
    vi.doMock('../config/loader', () => ({ resolveCertResolver: () => ({ name: 'web', resolver: null }) }));
    vi.doMock('../services/app', () => ({
      getApp: vi.fn(async () => baseApp('customer-portal')),
      applyApp: vi.fn(async (def: any) => ({ result: 'noop', app: def, changedKeys: [] })),
    }));
    vi.doMock('../services/envVars', () => ({
      generateSharedEnvFile: vi.fn(async () => undefined),
      deleteTenantAllOverrides: vi.fn(),
    }));
    vi.doMock('../services/manifestExtractor', () => ({
      readManifestFromAppImage: vi.fn(async () => null),
      resolveManifestImageRef: vi.fn(() => 'ghcr.io/acme/customer-portal/web-api:latest'),
    }));
    vi.doMock('../services/tenantTraefik', () => ({ readTenantTraefik: vi.fn(async () => undefined) }));
    vi.doMock('../services/tenantAppDef', () => ({
      readTenantAppDef: vi.fn(async () => baseApp('customer-portal')),
      writeTenantAppDef: vi.fn(async () => undefined),
    }));
    vi.doMock('../services/docker', () => ({ ensureExternalVolumes: vi.fn(async () => undefined) }));

    const rmiCalls: string[] = [];
    vi.doMock('child_process', () => ({
      execFile: withPromisify((_cmd, args, cb) => {
        if (args.includes('config') && args.includes('--images')) {
          cb(null, 'ghcr.io/acme/customer-portal/web-api:latest\n', '');
          return;
        }
        if (args[0] === 'rmi') {
          rmiCalls.push(args[1]);
          cb(null, '', '');
          return;
        }
        cb(null, '', '');
      }),
    }));

    const { updateTenant } = await import('../services/tenant');
    await updateTenant('customer-portal', 'tenant-one', 'latest');

    expect(rmiCalls).toEqual([]);
  });
});

