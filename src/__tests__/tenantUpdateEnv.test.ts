import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';

/** How a tenant update reads and edits the tenant .env. */

let tmpRoot: string;
let tenantPath: string;
const calls: string[][] = [];

function app() {
  return {
    id: 'shop', name: 'Shop', domain_template: '*.example.test',
    registry: { type: 'ghcr', url: 'ghcr.io', repository: 'acme/shop', auth: { type: 'token' } },
    services: [{
      name: 'web', image_suffix: 'web', required: true, ports: { internal: 3000 }, routing: { enabled: true, strip_prefix: false },
      env_mapping: { FRONTEND_URL: 'FRONTEND_URL' },
    }],
    default_image_tag: 'latest', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  } as any;
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-update-env-'));
  const appsDir = path.join(tmpRoot, 'apps');
  tenantPath = path.join(appsDir, 'shop', 'tenants', 't1');
  await fs.mkdir(tenantPath, { recursive: true });
  await fs.writeFile(path.join(tenantPath, 'docker-compose.yml'), 'services:\n  web:\n    image: x\n');
  calls.length = 0;
  vi.doMock('../utils/runDocker', async () => ({
    ...(await vi.importActual<object>('../utils/runDocker')),
    runDocker: vi.fn(async (_cmd: string, args: string[]) => { calls.push(args); return { stdout: '', stderr: '' }; }),
  }));
  vi.doMock('../services/fileLock', () => ({ withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn(), withTenantLock: <T>(_a: string, _t: string, fn: () => Promise<T>) => fn() }));
  vi.doMock('../config', () => ({
    loadConfig: () => ({
      project: { name: 'T', prefix: 'test', db_prefix: 'test' },
      database: { type: 'mariadb', host: 'db', port: 3306 },
      networking: { external_network: 'test-network' },
      traefik: { log_level: 'INFO', tls_termination: 'upstream', upstream_entrypoint: 'web' },
    }),
    getAppsDir: () => appsDir,
    getDataDir: () => path.join(tmpRoot, 'data'),
    resolveAppDbPrefix: () => 'test',
  }));
  vi.doMock('../config/loader', () => ({ resolveCertResolver: () => ({ name: 'web', resolver: null }) }));
  vi.doMock('../services/app', () => ({ getApp: vi.fn(async () => app()), applyApp: vi.fn() }));
  vi.doMock('../services/tenantTraefik', () => ({ readTenantTraefik: vi.fn(async () => undefined) }));
  vi.doMock('../services/envVars', async () => ({
    ...(await vi.importActual<object>('../services/envVars')),
    generateSharedEnvFile: vi.fn(async () => undefined),
  }));
  vi.doMock('../services/manifestExtractor', () => ({
    readManifestFromAppImage: vi.fn(async () => null),
    resolveManifestImageRef: vi.fn(() => 'ghcr.io/acme/shop/web:v2'),
  }));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
  for (const m of ['../utils/runDocker', '../services/fileLock', '../config', '../config/loader', '../services/app',
    '../services/tenantTraefik', '../services/envVars', '../services/manifestExtractor']) vi.doUnmock(m);
});

describe('updateTenant and the tenant .env', () => {
  it('refuses an update when the .env has no IMAGE_TAG line, and changes nothing', async () => {
    const env = 'TENANT_DOMAIN=t1.example.test\nDB_NAME=test_shop_t1\n';
    await fs.writeFile(path.join(tenantPath, '.env'), env);
    const { updateTenant } = await import('../services/tenant');

    await expect(updateTenant('shop', 't1', 'v2')).rejects.toThrow(/no IMAGE_TAG/);

    expect(await fs.readFile(path.join(tenantPath, '.env'), 'utf-8')).toBe(env);
    expect(calls).toEqual([]);
  });

  it('reads a quoted TENANT_DOMAIN as its value, and rewrites only the IMAGE_TAG line', async () => {
    // Single quotes are what formatEnvValue writes when a value needs quoting.
    await fs.writeFile(path.join(tenantPath, '.env'), "TENANT_DOMAIN='t1.example.test'\nIMAGE_TAG='v1'\nOTHER=keep\n");
    const { updateTenant } = await import('../services/tenant');

    await updateTenant('shop', 't1', 'v2');

    expect(await fs.readFile(path.join(tenantPath, '.env'), 'utf-8')).toBe("TENANT_DOMAIN='t1.example.test'\nIMAGE_TAG=v2\nOTHER=keep\n");
    const compose = yaml.load(await fs.readFile(path.join(tenantPath, 'docker-compose.yml'), 'utf-8')) as any;
    expect(compose.services.web.environment.FRONTEND_URL).toBe('https://t1.example.test');
    expect(compose.services.web.labels).toContain('traefik.http.routers.shop-t1-web.rule=Host(`t1.example.test`)');
  });
});
