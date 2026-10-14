import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const ONE_HOUR = 3_600_000;

let root: string;
let appsDir: string;
const calls: Array<{ args: string[]; timeout: number }> = [];

const timeoutOf = (verb: string, extra?: string) => {
  const c = calls.find(x => x.args.includes(verb) && (!extra || x.args.includes(extra)))!;
  expect(c, `no compose ${verb} call recorded`).toBeDefined();
  return c.timeout;
};

function baseApp() {
  return {
    id: 'demo',
    name: 'Demo',
    domain_template: '*.example.test',
    registry: { type: 'ghcr', url: 'ghcr.io', repository: 'acme/demo', auth: { type: 'token' } },
    services: [{ name: 'web', image_suffix: 'web', required: true, ports: { internal: 3000 } }],
    default_image_tag: 'latest',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as any;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-compose-timeouts-'));
  appsDir = path.join(root, 'apps');
  calls.length = 0;
  vi.doMock('child_process', () => ({
    execFile: vi.fn((_cmd: string, args: string[], opts: any, cb: any) => {
      calls.push({ args, timeout: opts?.timeout });
      cb(null, args.includes('--images') ? 'img:1\n' : '', '');
      return { on: () => {} };
    }),
  }));
  vi.doMock('../services/fileLock', () => ({
    withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn(),
    withTenantLock: <T>(_a: string, _t: string, fn: () => Promise<T>) => fn(),
  }));
  vi.doMock('../config', () => ({
    loadConfig: () => ({
      project: { name: 'T', prefix: 'test', db_prefix: 'test' },
      database: { type: 'mariadb', host: 'db', port: 3306, root_user: 'root', root_password_env: 'X', container_name: 'db' },
      networking: { external_network: 'n', internal_network_template: '${prefix}-${tenantId}-internal', apps_path: '/app/apps' },
      traefik: { log_level: 'INFO', tls_termination: 'upstream', upstream_entrypoint: 'web' },
    }),
    getAppsDir: () => appsDir,
    getDataDir: () => path.join(root, 'data'),
    resolveAppDbPrefix: () => 'test',
  }));
  vi.doMock('../config/loader', () => ({ resolveCertResolver: () => ({ name: 'web', resolver: null }) }));
  vi.doMock('../services/app', () => ({
    getApp: vi.fn(async () => baseApp()),
    applyApp: vi.fn(async (def: any) => ({ result: 'noop', app: def, changedKeys: [] })),
    listApps: vi.fn(async () => []),
  }));
  vi.doMock('../services/envVars', async () => ({
    ...(await vi.importActual<object>('../services/envVars')),
    generateSharedEnvFile: vi.fn(async () => undefined),
    deleteTenantAllOverrides: vi.fn(),
  }));
  vi.doMock('../services/manifestExtractor', () => ({
    readManifestFromAppImage: vi.fn(async () => null),
    resolveManifestImageRef: vi.fn(() => 'ghcr.io/acme/demo/web:2'),
  }));
  vi.doMock('../services/tenantTraefik', () => ({
    readTenantTraefik: vi.fn(async () => undefined),
    assertTenantDomainAllowed: vi.fn(async () => {}),
  }));
  vi.doMock('../services/tenantAppDef', () => ({
    readTenantAppDef: vi.fn(async () => baseApp()),
    writeTenantAppDef: vi.fn(async () => undefined),
  }));
  vi.doMock('../adapters/database', () => ({
    getDatabaseAdapter: () => ({
      initialize: vi.fn(async () => undefined),
      getDatabaseName: (t: string) => `test_${t}`,
      databaseExists: vi.fn(async () => false),
      createDatabase: vi.fn(async () => ({ created: true, userCreated: true })),
      dropDatabase: vi.fn(async () => undefined),
    }),
  }));
});

afterEach(async () => {
  vi.resetModules();
  for (const m of ['child_process', '../services/fileLock', '../config', '../config/loader', '../services/app', '../services/envVars',
    '../services/manifestExtractor', '../services/tenantTraefik', '../services/tenantAppDef', '../adapters/database']) vi.doUnmock(m);
  await fs.rm(root, { recursive: true, force: true });
});

async function mkTenant() {
  const p = path.join(appsDir, 'demo', 'tenants', 'one');
  await fs.mkdir(p, { recursive: true });
  await fs.writeFile(path.join(p, '.env'), 'APP_ID=demo\nTENANT_ID=one\nTENANT_DOMAIN=one.example.test\nIMAGE_TAG=1\n', { mode: 0o600 });
  await fs.writeFile(path.join(p, 'shared.env'), 'A=1\n');
  await fs.writeFile(path.join(p, 'docker-compose.yml'), 'services:\n  web:\n    image: ghcr.io/acme/demo/web:1\n');
}

describe('compose timeouts: long operations get a 1 h bound, quick ones stay short', () => {
  it('createTenant up -d', async () => {
    const { createTenant } = await import('../services/tenant');
    await createTenant({ appId: 'demo', tenantId: 'one', domain: 'one.example.test', imageTag: 'latest' });
    expect(timeoutOf('up')).toBe(ONE_HOUR);
  });

  it('updateTenant pull and up -d --force-recreate', async () => {
    await mkTenant();
    const { updateTenant } = await import('../services/tenant');
    await updateTenant('demo', 'one', '2');
    expect(timeoutOf('pull')).toBe(ONE_HOUR);
    expect(timeoutOf('up', '--remove-orphans')).toBe(ONE_HOUR);
    expect(timeoutOf('config')).toBeLessThan(ONE_HOUR);
  });

  it('startTenant and restartTenant', async () => {
    await mkTenant();
    const { startTenant, restartTenant, stopTenant } = await import('../services/docker');
    await startTenant('demo', 'one');
    expect(timeoutOf('up')).toBe(ONE_HOUR);
    calls.length = 0;
    await restartTenant('demo', 'one');
    expect(timeoutOf('up', '--force-recreate')).toBe(ONE_HOUR);
    calls.length = 0;
    await stopTenant('demo', 'one');
    expect(timeoutOf('down')).toBeLessThan(ONE_HOUR);
  });
});
