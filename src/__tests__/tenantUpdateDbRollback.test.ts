import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

/**
 * A failed update restart puts the previous image back. The new image's
 * migrations may already have changed the schema, so the database is dumped
 * before `up` and restored on that rollback.
 */

let tmpRoot: string;
let tenantPath: string;
const events: string[] = [];
let failNewUp = false;

const db = {
  initialize: vi.fn(async () => undefined),
  dumpDatabase: vi.fn(async (_id: string, out: string) => { events.push('db:dump'); await fs.writeFile(out, 'DUMP'); }),
  resetDatabase: vi.fn(async (id: string) => { events.push(`db:reset:${id}`); }),
  restoreDatabase: vi.fn(async (id: string, input: string, opts?: { password?: string }) => {
    events.push(`db:restore:${id}:${await fs.readFile(input, 'utf-8')}:${opts?.password}`);
  }),
};

function app() {
  return {
    id: 'shop', name: 'Shop', domain_template: '*.example.test',
    registry: { type: 'ghcr', url: 'ghcr.io', repository: 'acme/shop', auth: { type: 'token' } },
    services: [{ name: 'web', image_suffix: 'web', required: true, ports: { internal: 3000 } }],
    default_image_tag: 'latest', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  } as any;
}

const ENV = 'TENANT_DOMAIN=t1.example.test\nIMAGE_TAG=v1\nDB_NAME=test_shop_t1\nDB_PASSWORD=pw\n';

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-update-db-'));
  const appsDir = path.join(tmpRoot, 'apps');
  tenantPath = path.join(appsDir, 'shop', 'tenants', 't1');
  await fs.mkdir(tenantPath, { recursive: true });
  await fs.writeFile(path.join(tenantPath, 'docker-compose.yml'), 'services:\n  web:\n    image: x\n');
  await fs.writeFile(path.join(tenantPath, '.env'), ENV);
  events.length = 0;
  failNewUp = false;
  for (const fn of Object.values(db)) fn.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.doMock('../utils/runDocker', async () => ({
    ...(await vi.importActual<object>('../utils/runDocker')),
    runDocker: vi.fn(async (_cmd: string, args: string[]) => {
      if (args.includes('up') && args.includes('--remove-orphans')) {
        events.push('docker:up-new');
        if (failNewUp) throw Object.assign(new Error('migrator exited 1'), { stderr: 'service "migrator" didn\'t complete successfully' });
      } else if (args.includes('up')) {
        events.push('docker:up-old');
      } else if (args.includes('down')) {
        events.push(`docker:down${args.includes('-v') ? '-v' : ''}`);
      }
      return { stdout: '', stderr: '' };
    }),
  }));
  vi.doMock('../adapters/database', () => ({ getDatabaseAdapter: () => db }));
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
  vi.doMock('../adapters/registry', () => ({
    ensureRegistryLogin: vi.fn(async () => undefined),
    withRegistryLogin: vi.fn(async (_a: unknown, fn: () => Promise<unknown>) => fn()),
  }));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
  for (const m of ['../utils/runDocker', '../adapters/database', '../services/fileLock', '../config', '../config/loader',
    '../services/app', '../services/tenantTraefik', '../services/envVars', '../services/manifestExtractor', '../adapters/registry']) vi.doUnmock(m);
});

const tempDumpDirs = async () => (await fs.readdir(os.tmpdir())).filter(n => n.startsWith('overwatch-update-') && !n.startsWith('overwatch-update-db-'));

describe('tenant update and the database', () => {
  it('dumps the database before the new version starts, and discards the dump on success', async () => {
    const before = await tempDumpDirs();
    const { updateTenant } = await import('../services/tenant');
    await updateTenant('shop', 't1', 'v2');

    expect(events.slice(0, 2)).toEqual(['db:dump', 'docker:up-new']);
    expect(db.resetDatabase).not.toHaveBeenCalled();
    expect(db.restoreDatabase).not.toHaveBeenCalled();
    expect(await tempDumpDirs()).toEqual(before);
  });

  it('restores the pre-update database when the new version fails to start, before the old one starts again', async () => {
    failNewUp = true;
    const { updateTenant } = await import('../services/tenant');
    await expect(updateTenant('shop', 't1', 'v2')).rejects.toThrow(/restored to its state before the update/);

    // Prefix test, derived id shop_t1: the adapter adds the prefix itself.
    expect(events).toEqual(['db:dump', 'docker:up-new', 'docker:down', 'db:reset:shop_t1', 'db:restore:shop_t1:DUMP:pw', 'docker:up-old']);
    expect(await fs.readFile(path.join(tenantPath, '.env'), 'utf-8')).toBe(ENV);
  });

  it('stops before running the new version when the database cannot be dumped', async () => {
    db.dumpDatabase.mockRejectedValueOnce(new Error('mysqldump: access denied'));
    const { updateTenant } = await import('../services/tenant');
    await expect(updateTenant('shop', 't1', 'v2')).rejects.toThrow(/Could not back up the database.*Nothing was changed/s);

    expect(events).not.toContain('docker:up-new');
    expect(await fs.readFile(path.join(tenantPath, '.env'), 'utf-8')).toBe(ENV);
  });

  it('keeps the dump in the tenant directory when the database cannot be restored', async () => {
    failNewUp = true;
    db.restoreDatabase.mockRejectedValueOnce(new Error('import failed'));
    const { updateTenant } = await import('../services/tenant');
    await expect(updateTenant('shop', 't1', 'v2')).rejects.toThrow(/could NOT be restored.*pre-update-.*\.sql/s);

    const kept = (await fs.readdir(tenantPath)).filter(n => /^pre-update-.*\.sql$/.test(n));
    expect(kept).toHaveLength(1);
    expect(await fs.readFile(path.join(tenantPath, kept[0]), 'utf-8')).toBe('DUMP');
    expect((await fs.stat(path.join(tenantPath, kept[0]))).mode & 0o777).toBe(0o600);
    expect(events.at(-1)).toBe('docker:up-old');
  });
});
