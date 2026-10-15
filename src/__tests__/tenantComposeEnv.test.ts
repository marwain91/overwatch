import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let tmpRoot: string;
let appsDir: string;
const SAVED = { ...process.env };

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-compose-env-'));
  appsDir = path.join(tmpRoot, 'apps');
  const tenantPath = path.join(appsDir, 'demo', 'tenants', 'tenant-one');
  await fs.mkdir(tenantPath, { recursive: true });
  await fs.writeFile(path.join(tenantPath, '.env'), 'DB_NAME=test_demo_tenant_one\nJWT_SECRET=tenant-secret\n');
  await fs.writeFile(path.join(tenantPath, 'docker-compose.yml'), 'services: {}\n');
  process.env.JWT_SECRET = 'overwatch-secret'; // tenant .env holds its own JWT_SECRET=tenant-secret; compose must resolve it from there
  process.env.MYSQL_ROOT_PASSWORD = 'root-pw';
  process.env.DOCKER_CONFIG = '/home/ow/.docker';
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
  vi.resetModules();
  vi.doUnmock('child_process');
  vi.doUnmock('../config');
  vi.doUnmock('../config/loader');
  vi.doUnmock('../adapters/database');
  vi.doUnmock('../services/app');
  vi.doUnmock('../services/envVars');
});

describe('tenant compose calls', () => {
  it('run with a curated environment, without Overwatch secrets', async () => {
    const envs: NodeJS.ProcessEnv[] = [];
    vi.doMock('child_process', () => ({
      execFile: vi.fn((_cmd: string, _args: string[], opts: any, cb: any) => {
        envs.push(opts.env);
        cb(null, '', '');
      }),
    }));
    vi.doMock('../services/fileLock', () => ({ withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn(), withTenantLock: <T>(_a: string, _t: string, fn: () => Promise<T>) => fn() }));
    vi.doMock('../config', () => ({
      loadConfig: () => ({ project: { name: 'T', prefix: 'test', db_prefix: 'test' } }),
      getAppsDir: () => appsDir,
      resolveAppDbPrefix: () => 'test',
    }));
    vi.doMock('../config/loader', () => ({ resolveCertResolver: () => ({ name: 'web', resolver: null }) }));
    vi.doMock('../adapters/database', () => ({
      getDatabaseAdapter: () => ({ initialize: vi.fn(async () => undefined), dropDatabase: vi.fn(async () => undefined) }),
    }));
    vi.doMock('../services/app', () => ({ getApp: vi.fn(async () => ({ id: 'demo', services: [] })), applyApp: vi.fn() }));
    vi.doMock('../services/envVars', () => ({ generateSharedEnvFile: vi.fn(), deleteTenantAllOverrides: vi.fn() }));
    const { deleteTenant } = await import('../services/tenant');

    await deleteTenant('demo', 'tenant-one');

    expect(envs.length).toBeGreaterThan(0);
    for (const env of envs) {
      expect(env).toBeDefined();
      expect(env).not.toHaveProperty('JWT_SECRET');
      expect(env).not.toHaveProperty('MYSQL_ROOT_PASSWORD');
      expect(env.DOCKER_CONFIG).toBe('/home/ow/.docker');
    }
  });
});
