import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

/**
 * Every docker / docker compose call tenant.ts makes goes through
 * utils/runDocker (env allowlist, timeouts, classified errors), never through
 * child_process directly.
 */

let tmpRoot: string;
let appsDir: string;
const direct: string[][] = [];
const viaRunDocker: string[][] = [];

function app() {
  return {
    id: 'portal', name: 'Portal', domain_template: '*.example.test',
    registry: { type: 'ghcr', url: 'ghcr.io', repository: 'acme/portal', auth: { type: 'token' } },
    services: [{ name: 'web', image_suffix: 'web', required: true, ports: { internal: 3000 } }],
    default_image_tag: 'latest', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  } as any;
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-rundocker-'));
  appsDir = path.join(tmpRoot, 'apps');
  direct.length = 0;
  viaRunDocker.length = 0;
  vi.doMock('child_process', () => ({
    execFile: vi.fn((_cmd: string, args: string[], _opts: unknown, cb: (e: any, so: string, se: string) => void) => {
      direct.push(args);
      cb(null, '', '');
      return { on: () => {} };
    }),
  }));
  vi.doMock('../utils/runDocker', async () => ({
    ...(await vi.importActual<object>('../utils/runDocker')),
    runDocker: vi.fn(async (_cmd: string, args: string[]) => {
      viaRunDocker.push(args);
      return { stdout: args.includes('--images') ? 'ghcr.io/acme/portal/web:v1\n' : '', stderr: '' };
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
    resolveManifestImageRef: vi.fn(() => 'ghcr.io/acme/portal/web:v2'),
  }));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
  for (const m of ['child_process', '../utils/runDocker', '../services/fileLock', '../config', '../config/loader', '../adapters/database',
    '../services/app', '../services/tenantTraefik', '../services/envVars', '../services/manifestExtractor']) vi.doUnmock(m);
});

describe('tenant lifecycle docker calls', () => {
  it('create, update and delete never spawn docker outside runDocker', async () => {
    const { createTenant, updateTenant, deleteTenant } = await import('../services/tenant');
    await createTenant({ appId: 'portal', tenantId: 'one', domain: 'one.example.test', imageTag: 'v1' });
    await updateTenant('portal', 'one', 'v2');
    await deleteTenant('portal', 'one');

    expect(direct).toEqual([]);
    const verbs = viaRunDocker.map(a => a.find(x => ['up', 'pull', 'down', 'config'].includes(x)));
    expect(verbs).toEqual(expect.arrayContaining(['up', 'pull', 'down', 'config']));
  });
});
