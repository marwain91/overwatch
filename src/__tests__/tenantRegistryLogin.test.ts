import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Tenant create and update log in to the app's registry right before compose
// pulls, so an app added after boot or a rotated token works without a restart.

let tmpRoot: string;
let appsDir: string;
const events: string[] = [];
const ensureRegistryLogin = vi.fn();
const db = {
  initialize: vi.fn(async () => undefined),
  databaseExists: vi.fn(async () => false),
  createDatabase: vi.fn(async () => ({ created: true, userCreated: true })),
  dropDatabase: vi.fn(async () => { events.push('db:drop'); }),
  getDatabaseName: (id: string) => id,
};

function app() {
  return {
    id: 'portal', name: 'Portal', domain_template: '*.example.test',
    registry: { type: 'ghcr', url: 'ghcr.io', repository: 'acme/portal', auth: { type: 'token', token_env: 'GHCR_TOKEN' } },
    services: [{ name: 'web', image_suffix: 'web', required: true, ports: { internal: 3000 } }],
    default_image_tag: 'latest', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  } as any;
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-registry-login-'));
  appsDir = path.join(tmpRoot, 'apps');
  events.length = 0;
  ensureRegistryLogin.mockReset();
  ensureRegistryLogin.mockImplementation(async (a: any) => { events.push(`login:${a.id}`); });
  vi.doMock('../services/fileLock', () => ({
    withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn(),
    withTenantLock: <T>(_a: string, _t: string, fn: () => Promise<T>) => fn(),
  }));
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
  vi.doMock('../adapters/database', () => ({ getDatabaseAdapter: () => db }));
  vi.doMock('../adapters/registry', () => ({ ensureRegistryLogin }));
  vi.doMock('../services/app', () => ({
    getApp: vi.fn(async () => app()),
    applyApp: vi.fn(async (def: any) => ({ result: 'noop', app: def, changedKeys: [] })),
  }));
  vi.doMock('../services/tenantTraefik', () => ({
    readTenantTraefik: vi.fn(async () => undefined),
    assertTenantDomainAllowed: vi.fn(async () => undefined),
  }));
  vi.doMock('../services/envVars', () => ({
    generateSharedEnvFile: vi.fn(async () => undefined),
    deleteTenantAllOverrides: vi.fn(),
    formatEnvValue: (v: unknown) => String(v),
  }));
  vi.doMock('../services/manifestExtractor', () => ({
    readManifestFromAppImage: vi.fn(async () => null),
    resolveManifestImageRef: vi.fn(() => 'ghcr.io/acme/portal/web:v2'),
  }));
  vi.doMock('../services/tenantAppDef', () => ({
    readTenantAppDef: vi.fn(async () => app()),
    writeTenantAppDef: vi.fn(async () => undefined),
  }));
  vi.doMock('../services/initContainerDiagnostics', () => ({ describeFailedInitContainers: vi.fn(async () => '') }));
  vi.doMock('../services/docker', () => ({ ensureExternalVolumes: vi.fn(async () => undefined) }));
  vi.doMock('child_process', () => ({
    execFile: vi.fn((_cmd: string, args: string[], _opts: unknown, cb: (e: any, so: string, se: string) => void) => {
      const verb = args.find(a => ['create', 'up', 'down', 'pull', 'config', 'rmi'].includes(a)) ?? args[0];
      events.push(`docker:${verb}`);
      cb(null, '', '');
    }),
  }));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
  for (const m of ['../services/fileLock', '../config', '../config/loader', '../adapters/database', '../adapters/registry',
    '../services/app', '../services/tenantTraefik', '../services/envVars', '../services/manifestExtractor',
    '../services/tenantAppDef', '../services/initContainerDiagnostics', '../services/docker', 'child_process']) vi.doUnmock(m);
});

async function seedTenant(): Promise<string> {
  const tenantPath = path.join(appsDir, 'portal', 'tenants', 'one');
  await fs.mkdir(tenantPath, { recursive: true });
  await fs.writeFile(path.join(tenantPath, '.env'), 'APP_ID=portal\nTENANT_ID=one\nTENANT_DOMAIN=one.example.test\nIMAGE_TAG=v1\n', { mode: 0o600 });
  await fs.writeFile(path.join(tenantPath, 'docker-compose.yml'), 'services: {}\n');
  return tenantPath;
}

describe('tenant create', () => {
  it('logs in to the app registry before compose pulls the images', async () => {
    const { createTenant } = await import('../services/tenant');
    await createTenant({ appId: 'portal', tenantId: 'one', domain: 'one.example.test', imageTag: 'v1' });
    expect(events).toContain('login:portal');
    expect(events.indexOf('login:portal')).toBeLessThan(events.indexOf('docker:up'));
  });

  it('rolls back if the registry login step throws', async () => {
    ensureRegistryLogin.mockRejectedValue(new Error("Registry login to ghcr.io failed for app 'portal': denied"));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { createTenant, getTenantPath } = await import('../services/tenant');
    await expect(createTenant({ appId: 'portal', tenantId: 'one', domain: 'one.example.test', imageTag: 'v1' }))
      .rejects.toThrow(/Failed to create tenant: Registry login to ghcr\.io failed for app 'portal'/);
    expect(events).not.toContain('docker:up');
    expect(events).toContain('docker:down');
    expect(events).toContain('db:drop');
    await expect(fs.access(getTenantPath('portal', 'one'))).rejects.toThrow();
  });
});

describe('tenant update', () => {
  it('logs in to the app registry before compose pulls the new images', async () => {
    await seedTenant();
    const { updateTenant } = await import('../services/tenant');
    await updateTenant('portal', 'one', 'v2');
    expect(events).toContain('login:portal');
    expect(events.indexOf('login:portal')).toBeLessThan(events.indexOf('docker:pull'));
  });

  it('restores the tenant and reports the pull step failed if the registry login step throws', async () => {
    const tenantPath = await seedTenant();
    ensureRegistryLogin.mockRejectedValue(new Error("Registry login to ghcr.io failed for app 'portal': denied"));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const progress: Array<{ step: string; status: string; detail?: string }> = [];
    const { updateTenant } = await import('../services/tenant');
    await expect(updateTenant('portal', 'one', 'v2', p => progress.push(p)))
      .rejects.toThrow(/Registry login to ghcr\.io failed for app 'portal'/);
    expect(events).not.toContain('docker:pull');
    expect(progress).toContainEqual(expect.objectContaining({ step: 'pull', status: 'failed' }));
    await expect(fs.readFile(path.join(tenantPath, '.env'), 'utf-8')).resolves.toContain('IMAGE_TAG=v1');
  });
});
