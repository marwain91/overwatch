import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import { updateDbMethods } from './updateDbMock';

/**
 * Tenant lifecycle around volumes: an existing tenant keeps the volume names
 * its compose file declares, and nothing removes a volume another tenant may
 * share (`down -v` only ever sees volumes the tenant owns).
 */

let tmpRoot: string;
let appsDir: string;
let tenantPath: string;
let upFails = false;
const calls: Array<{ args: string[]; compose?: string }> = [];

const LEGACY_COMPOSE = [
  'services:',
  '  web:',
  '    image: x',
  '    volumes:',
  '      - uploads:/data',
  '      - shop-t1-media:/media',
  'volumes:',
  '  uploads:',
  '    name: uploads',
  '  shop-t1-media:',
  '    name: shop-t1-media',
  '',
].join('\n');

function app() {
  return {
    id: 'shop', name: 'Shop', domain_template: '*.example.test',
    registry: { type: 'ghcr', url: 'ghcr.io', repository: 'acme/shop', auth: { type: 'token' } },
    services: [{
      name: 'web', image_suffix: 'web', required: true, ports: { internal: 3000 },
      volumes: [
        { name: 'uploads', container_path: '/data' },
        { name: 'media', container_path: '/media', name_template: '${appId}-${tenantId}-media' },
      ],
    }],
    default_image_tag: 'latest', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  } as any;
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-tenant-volumes-'));
  appsDir = path.join(tmpRoot, 'apps');
  tenantPath = path.join(appsDir, 'shop', 'tenants', 't1');
  calls.length = 0;
  upFails = false;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.doMock('../utils/runDocker', async () => ({
    ...(await vi.importActual<object>('../utils/runDocker')),
    runDocker: vi.fn(async (_cmd: string, args: string[]) => {
      const f = args.indexOf('-f');
      const compose = f >= 0 ? await fs.readFile(args[f + 1], 'utf-8').catch(() => undefined) : undefined;
      calls.push({ args, compose });
      if (upFails && args.includes('up')) throw Object.assign(new Error('up failed'), { stderr: 'Error: up failed' });
      return { stdout: '', stderr: '' };
    }),
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
  vi.doMock('../adapters/database', () => ({
    getDatabaseAdapter: () => ({
      ...updateDbMethods(),
      initialize: vi.fn(async () => undefined),
      databaseExists: vi.fn(async () => false),
      createDatabase: vi.fn(async () => ({ created: true, userCreated: true })),
      dropDatabase: vi.fn(async () => undefined),
      getDatabaseName: (id: string) => `test_${id}`,
    }),
  }));
  vi.doMock('../services/app', () => ({ getApp: vi.fn(async () => app()), applyApp: vi.fn(), listApps: vi.fn(async () => [app()]) }));
  vi.doMock('../services/tenantTraefik', () => ({ readTenantTraefik: vi.fn(async () => undefined), assertTenantDomainAllowed: vi.fn(async () => undefined) }));
  vi.doMock('../services/envVars', async () => ({
    ...(await vi.importActual<object>('../services/envVars')),
    generateSharedEnvFile: vi.fn(async () => undefined),
    deleteTenantAllOverrides: vi.fn(async () => undefined),
  }));
  vi.doMock('../services/manifestExtractor', () => ({
    readManifestFromAppImage: vi.fn(async () => null),
    resolveManifestImageRef: vi.fn(() => 'ghcr.io/acme/shop/web:v2'),
  }));
  vi.doMock('../services/initContainerDiagnostics', () => ({ describeFailedInitContainers: vi.fn(async () => '') }));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
  for (const m of ['../utils/runDocker', '../services/fileLock', '../config', '../config/loader', '../adapters/database', '../services/app',
    '../services/tenantTraefik', '../services/envVars', '../services/manifestExtractor', '../services/initContainerDiagnostics']) vi.doUnmock(m);
});

async function existingTenant(compose = LEGACY_COMPOSE) {
  await fs.mkdir(tenantPath, { recursive: true });
  await fs.writeFile(path.join(tenantPath, '.env'), 'TENANT_DOMAIN=t1.example.test\nIMAGE_TAG=v1\nDB_NAME=test_shop_t1\n', { mode: 0o600 });
  await fs.writeFile(path.join(tenantPath, 'docker-compose.yml'), compose);
}

describe('tenant volumes across the lifecycle', () => {
  it('an update keeps the unscoped volume an existing tenant uses, declared external', async () => {
    await existingTenant();
    const { updateTenant } = await import('../services/tenant');
    await updateTenant('shop', 't1', 'v2');

    const doc = yaml.load(await fs.readFile(path.join(tenantPath, 'docker-compose.yml'), 'utf-8')) as any;
    expect(doc.services.web.volumes).toEqual(['uploads:/data', 'shop-t1-media:/media']);
    expect(doc.volumes).toEqual({ uploads: { external: true }, 'shop-t1-media': { name: 'shop-t1-media' } });
  });

  it('a failed create rolls back without removing volumes', async () => {
    upFails = true;
    const { createTenant } = await import('../services/tenant');
    await expect(createTenant({ appId: 'shop', tenantId: 't1', domain: 't1.example.test', imageTag: 'v1' })).rejects.toThrow(/up failed/);

    const downs = calls.filter(c => c.args.includes('down'));
    expect(downs).toHaveLength(1);
    expect(downs[0].args).not.toContain('-v');
  });

  it('a delete removes only the volumes the tenant owns, even from a compose file written before scoped names', async () => {
    await existingTenant();
    const { deleteTenant } = await import('../services/tenant');
    await deleteTenant('shop', 't1');

    const down = calls.find(c => c.args.includes('down'))!;
    expect(down.args).toContain('-v');
    const doc = yaml.load(down.compose!) as any;
    expect(doc.volumes.uploads).toEqual({ external: true, name: 'uploads' });
    expect(doc.volumes['shop-t1-media']).toEqual({ name: 'shop-t1-media' });
    expect(doc.services.web.volumes).toEqual(['uploads:/data', 'shop-t1-media:/media']);
  });
});
