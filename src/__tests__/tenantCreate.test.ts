import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { assertSafeIdentifier } from '../utils/security';

let tmpRoot: string;
let appsDir: string;
const dockerCalls: string[][] = [];
const events: string[] = [];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const db = {
  initialize: vi.fn(async () => undefined),
  databaseExists: vi.fn(async () => false),
  // Same identifier rule as the real adapters.
  createDatabase: vi.fn(async (id: string) => { assertSafeIdentifier(id); events.push('db'); return { created: true, userCreated: true }; }),
  dropDatabase: vi.fn(async () => undefined),
  getDatabaseName: (id: string) => id,
};
let assertDomain: (appId: string, tenantId: string, domain: string) => Promise<void>;
let dbType = 'mariadb';

function app(id = 'portal') {
  return {
    id, name: 'Portal', domain_template: '*.example.test',
    registry: { type: 'ghcr', url: 'ghcr.io', repository: 'acme/portal', auth: { type: 'token' } },
    services: [{ name: 'web', image_suffix: 'web', required: true, ports: { internal: 3000 } }],
    default_image_tag: 'latest', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  } as any;
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-create-'));
  appsDir = path.join(tmpRoot, 'apps');
  dockerCalls.length = 0;
  events.length = 0;
  assertDomain = async () => undefined;
  dbType = 'mariadb';
  db.createDatabase.mockClear();
  vi.doMock('../config', () => ({
    loadConfig: () => ({
      project: { name: 'T', prefix: 'test', db_prefix: 'test' },
      database: { type: dbType, host: 'db', port: 3306 },
      networking: { external_network: 'test-network' },
      traefik: { log_level: 'INFO', tls_termination: 'upstream', upstream_entrypoint: 'web' },
    }),
    getAppsDir: () => appsDir,
    getDataDir: () => path.join(tmpRoot, 'data'),
    resolveAppDbPrefix: () => 'test',
  }));
  vi.doMock('../config/loader', () => ({ resolveCertResolver: () => ({ name: 'web', resolver: null }) }));
  vi.doMock('../adapters/database', () => ({ getDatabaseAdapter: () => db }));
  vi.doMock('../services/app', () => ({ getApp: vi.fn(async (id: string) => app(id)), applyApp: vi.fn() }));
  vi.doMock('../services/tenantTraefik', () => ({
    readTenantTraefik: vi.fn(async () => undefined),
    assertTenantDomainAllowed: (a: string, t: string, d: string) => assertDomain(a, t, d),
  }));
  vi.doMock('../services/envVars', () => ({
    generateSharedEnvFile: vi.fn(async () => undefined),
    deleteTenantAllOverrides: vi.fn(),
    formatEnvValue: (v: unknown) => String(v),
  }));
  vi.doMock('../services/tenantAppDef', () => ({ readTenantAppDef: vi.fn(), writeTenantAppDef: vi.fn(async () => undefined) }));
  vi.doMock('../services/docker', () => ({ ensureExternalVolumes: vi.fn(async () => undefined) }));
  vi.doMock('child_process', () => ({
    execFile: vi.fn((_cmd: string, args: string[], _opts: unknown, cb: (e: any, so: string, se: string) => void) => {
      dockerCalls.push(args);
      const verb = args.find(a => ['create', 'up', 'down'].includes(a)) ?? '';
      events.push(`docker:${verb}`);
      cb(null, '', '');
    }),
  }));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
  for (const m of ['../config', '../config/loader', '../adapters/database', '../services/app', '../services/tenantTraefik',
    '../services/envVars', '../services/tenantAppDef', '../services/docker', 'child_process']) vi.doUnmock(m);
  db.databaseExists.mockImplementation(async () => false);
});

const input = (tenantId: string, domain = `${tenantId}.example.test`, appId = 'portal') => ({ appId, tenantId, domain, imageTag: 'v1' });

describe('createTenant start option', () => {
  it('start:false creates the DB and containers but never runs `up`', async () => {
    const { createTenant } = await import('../services/tenant');
    await createTenant({ ...input('one'), start: false });
    expect(dockerCalls.some(a => a.includes('up'))).toBe(false);
    expect(dockerCalls.some(a => a.includes('create'))).toBe(true);
    expect(events.indexOf('db')).toBeLessThan(events.indexOf('docker:create'));
  });

  it('defaults to `up -d`', async () => {
    const { createTenant } = await import('../services/tenant');
    await createTenant(input('one'));
    expect(dockerCalls.some(a => a.includes('up') && a.includes('-d'))).toBe(true);
    expect(dockerCalls.some(a => a.includes('create'))).toBe(false);
  });

  it('startCreatedTenantLocked brings up created containers without recreating them', async () => {
    const { createTenant, startCreatedTenantLocked } = await import('../services/tenant');
    await createTenant({ ...input('one'), start: false });
    await startCreatedTenantLocked('portal', 'one');
    const up = dockerCalls.find(a => a.includes('up'))!;
    expect(up).toEqual(expect.arrayContaining(['up', '-d', '--no-recreate']));
  });
});

describe('createTenant error handling', () => {
  it('rethrows a rejected domain as-is (not wrapped in a 500) and leaves no directory', async () => {
    const { ValidationError } = await import('../utils/httpErrors');
    assertDomain = async () => { throw new ValidationError('Domain "x" is not allowed'); };
    const { createTenant, getTenantPath } = await import('../services/tenant');
    await expect(createTenant(input('one'))).rejects.toBeInstanceOf(ValidationError);
    await expect(fs.access(getTenantPath('portal', 'one'))).rejects.toThrow();
  });

  it('reports an existing tenant as ConflictError and keeps its directory', async () => {
    const { ConflictError } = await import('../utils/httpErrors');
    const { createTenant, getTenantPath } = await import('../services/tenant');
    await fs.mkdir(getTenantPath('portal', 'one'), { recursive: true });
    await fs.writeFile(path.join(getTenantPath('portal', 'one'), '.env'), 'KEEP=1\n');
    await expect(createTenant(input('one'))).rejects.toBeInstanceOf(ConflictError);
    await expect(fs.readFile(path.join(getTenantPath('portal', 'one'), '.env'), 'utf-8')).resolves.toBe('KEEP=1\n');
  });
});

describe('createTenant domain uniqueness', () => {
  it('lets only one of two concurrent creates claim the same domain', async () => {
    const { ConflictError } = await import('../utils/httpErrors');
    // Mirrors the real check: other tenants' .env TENANT_DOMAIN is the source of truth.
    assertDomain = async (_a, tenantId, domain) => {
      await sleep(15);
      const root = path.join(appsDir, 'portal', 'tenants');
      for (const other of await fs.readdir(root).catch(() => [] as string[])) {
        if (other === tenantId) continue;
        const env = await fs.readFile(path.join(root, other, '.env'), 'utf-8').catch(() => '');
        if (env.includes(`TENANT_DOMAIN=${domain}\n`)) throw new ConflictError(`Domain "${domain}" is already used by another tenant`);
      }
    };
    const { createTenant } = await import('../services/tenant');
    const results = await Promise.allSettled([
      createTenant(input('one', 'shared.example.test')),
      createTenant(input('two', 'shared.example.test')),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictError);
  });
});

describe('createTenant derived names', () => {
  it('creates a tenant with a hyphenated id, mapping "-" to "_" in the database name only', async () => {
    const { createTenant, getTenantPath } = await import('../services/tenant');
    await createTenant(input('eu-west'));
    expect(db.createDatabase).toHaveBeenCalledWith('portal_eu_west', expect.any(String));
    const env = await fs.readFile(path.join(getTenantPath('portal', 'eu-west'), '.env'), 'utf-8');
    expect(env).toContain('COMPOSE_PROJECT_NAME=portal-eu-west\n');
    expect(env).toContain('DB_NAME=portal_eu_west\n');
  });

  it('refuses a tenant whose compose project and database would collide with an existing tenant', async () => {
    const { ConflictError } = await import('../utils/httpErrors');
    const { createTenant, getTenantPath } = await import('../services/tenant');
    await createTenant(input('eu-west'));
    db.createDatabase.mockClear();

    const err = await createTenant(input('west', 'west.example.test', 'portal-eu')).catch(e => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toMatch(/compose project 'portal-eu-west' is already used by tenant 'eu-west' of app 'portal'/);
    expect(db.createDatabase).not.toHaveBeenCalled();
    await expect(fs.access(getTenantPath('portal-eu', 'west'))).rejects.toThrow();
  });

  it('rejects up front a tenant whose MySQL user name would exceed 32 characters', async () => {
    dbType = 'mysql';
    const { ValidationError } = await import('../utils/httpErrors');
    const { createTenant, getTenantPath } = await import('../services/tenant');
    const tenantId = 'a-very-long-tenant-name-x'; // portal_ + 25 = 32 characters
    await expect(createTenant(input(tenantId))).resolves.toBeDefined();

    const tooLong = `${tenantId}y`;
    const err = await createTenant(input(tooLong)).catch(e => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/at most 32 characters/);
    await expect(fs.access(getTenantPath('portal', tooLong))).rejects.toThrow();
  });
});

describe('createTenant over a kept database', () => {
  it('explains that the database was kept by an earlier delete and what to do', async () => {
    db.databaseExists.mockImplementation(async () => true);
    const { ConflictError } = await import('../utils/httpErrors');
    const { createTenant } = await import('../services/tenant');
    const err = await createTenant(input('one')).catch(e => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toMatch(/database 'portal_one' already exists/);
    expect(err.message).toMatch(/Keep data/);
    expect(err.message).toMatch(/deleted-tenants\/portal/);
    expect(db.createDatabase).not.toHaveBeenCalled();
  });
});
