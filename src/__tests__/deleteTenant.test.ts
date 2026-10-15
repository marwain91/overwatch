import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let tmpRoot: string;
let appsDir: string;
let tenantPath: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-delete-tenant-'));
  appsDir = path.join(tmpRoot, 'apps');
  tenantPath = path.join(appsDir, 'demo', 'tenants', 'tenant-one');
  await fs.mkdir(tenantPath, { recursive: true });
  await fs.writeFile(path.join(tenantPath, '.env'), 'DB_NAME=test_demo_tenant_one\n');
  await fs.writeFile(path.join(tenantPath, 'docker-compose.yml'), 'services: {}\n');
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
  vi.doUnmock('child_process');
  vi.doUnmock('../config');
  vi.doUnmock('../config/loader');
  vi.doUnmock('../adapters/database');
  vi.doUnmock('../services/app');
  vi.doUnmock('../services/envVars');
});

let globalApp: any;

async function loadDeleteTenant(composeDown: (cb: (err: any, stdout: string, stderr: string) => void) => void) {
  const calls: string[] = [];
  const dropped: string[] = [];
  const composeCalls: string[][] = [];
  const db = {
    initialize: vi.fn(async () => undefined),
    dropDatabase: vi.fn(async () => { calls.push('dropDatabase'); }),
  };
  // Adapters prepend their db_prefix, as the real ones do; `dropped` holds full names.
  const adapterFor = (prefix: string) => ({
    ...db,
    dropDatabase: vi.fn(async (id: string) => { dropped.push(prefix ? `${prefix}_${id}` : id); await db.dropDatabase(); }),
  });
  const deleteTenantAllOverrides = vi.fn(async () => { calls.push('deleteOverrides'); });
  vi.doMock('child_process', () => ({
    execFile: vi.fn((_cmd: string, args: string[], _opts: unknown, cb: (err: any, stdout: string, stderr: string) => void) => {
      composeCalls.push(args);
      composeDown(cb);
      return { on: () => {} };
    }),
  }));
  vi.doMock('../services/fileLock', () => ({ withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn(), withTenantLock: <T>(_a: string, _t: string, fn: () => Promise<T>) => fn() }));
  vi.doMock('../config', () => ({
    loadConfig: () => ({ project: { name: 'T', prefix: 'test', db_prefix: 'test' } }),
    getAppsDir: () => appsDir,
    resolveAppDbPrefix: (app?: { db_prefix?: string }) => app?.db_prefix ?? 'test',
  }));
  vi.doMock('../config/loader', () => ({ resolveCertResolver: () => ({ name: 'web', resolver: null }) }));
  vi.doMock('../adapters/database', () => ({
    getDatabaseAdapter: (app?: { db_prefix?: string }) => adapterFor(app?.db_prefix ?? 'test'),
  }));
  vi.doMock('../services/app', () => ({ getApp: vi.fn(async () => globalApp), applyApp: vi.fn() }));
  vi.doMock('../services/envVars', () => ({ generateSharedEnvFile: vi.fn(), deleteTenantAllOverrides }));
  const { deleteTenant } = await import('../services/tenant');
  return { deleteTenant, db, deleteTenantAllOverrides, calls, dropped, composeCalls };
}

/** A tenant's frozen app-definition snapshot, as tenant create writes it. */
async function writeSnapshot(dbPrefix: string) {
  await fs.writeFile(path.join(tenantPath, 'app-definition.json'), JSON.stringify({
    id: 'demo', name: 'Demo', domain_template: '*.demo.test',
    registry: { type: 'ghcr', url: 'ghcr.io', repository: 'acme/demo', auth: { type: 'token' } },
    services: [{ name: 'web' }], default_image_tag: 'latest', db_prefix: dbPrefix,
  }));
}

beforeEach(() => { globalApp = { id: 'demo', services: [] }; });

describe('deleteTenant', () => {
  it('keeps env overrides (and the DB) when compose down fails, so a retry still has them', async () => {
    const { deleteTenant, db, deleteTenantAllOverrides } = await loadDeleteTenant(cb => cb(new Error('compose down failed'), '', ''));

    await expect(deleteTenant('demo', 'tenant-one')).rejects.toThrow(/Refusing to drop database/);

    expect(deleteTenantAllOverrides).not.toHaveBeenCalled();
    expect(db.dropDatabase).not.toHaveBeenCalled();
    await expect(fs.access(tenantPath)).resolves.toBeUndefined();
  });

  it('removes overrides only after the database is dropped', async () => {
    const { deleteTenant, calls } = await loadDeleteTenant(cb => cb(null, '', ''));

    await deleteTenant('demo', 'tenant-one');

    expect(calls).toEqual(['dropDatabase', 'deleteOverrides']);
    await expect(fs.access(tenantPath)).rejects.toThrow();
  });

  it('drops the database named in the .env of a tenant whose app is in the trash', async () => {
    globalApp = null; // trashed: getApp() no longer finds it
    await writeSnapshot('custom');
    await fs.writeFile(path.join(tenantPath, '.env'), 'DB_NAME=custom_demo_tenant_one\n');
    const { deleteTenant, dropped } = await loadDeleteTenant(cb => cb(null, '', ''));

    await deleteTenant('demo', 'tenant-one');

    expect(dropped).toEqual(['custom_demo_tenant_one']);
  });

  it('uses the snapshot db_prefix when the .env has no DB_NAME', async () => {
    globalApp = null;
    await writeSnapshot('custom');
    await fs.writeFile(path.join(tenantPath, '.env'), 'TENANT_DOMAIN=x.demo.test\n');
    const { deleteTenant, dropped } = await loadDeleteTenant(cb => cb(null, '', ''));

    await deleteTenant('demo', 'tenant-one');

    expect(dropped).toEqual(['custom_demo_tenant_one']);
  });

  it('refuses to delete, before stopping anything, when the database cannot be determined', async () => {
    globalApp = null; // no snapshot, no global definition, no DB_NAME
    await fs.writeFile(path.join(tenantPath, '.env'), 'TENANT_DOMAIN=x.demo.test\n');
    const { deleteTenant, db, composeCalls } = await loadDeleteTenant(cb => cb(null, '', ''));

    await expect(deleteTenant('demo', 'tenant-one')).rejects.toThrow(/cannot determine the database/i);

    expect(composeCalls).toEqual([]);
    expect(db.dropDatabase).not.toHaveBeenCalled();
    await expect(fs.access(tenantPath)).resolves.toBeUndefined();
  });

  it('refuses to delete when the .env cannot be read', async () => {
    await fs.rm(path.join(tenantPath, '.env'));
    await fs.mkdir(path.join(tenantPath, '.env'));
    const { deleteTenant, db, composeCalls } = await loadDeleteTenant(cb => cb(null, '', ''));

    await expect(deleteTenant('demo', 'tenant-one')).rejects.toThrow(/cannot determine the database/i);
    expect(composeCalls).toEqual([]);
    expect(db.dropDatabase).not.toHaveBeenCalled();
  });
});
