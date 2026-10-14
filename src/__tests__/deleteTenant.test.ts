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
  await fs.writeFile(path.join(tenantPath, '.env'), 'DB_NAME=test_demo_tenant-one\n');
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

async function loadDeleteTenant(composeDown: (cb: (err: any, stdout: string, stderr: string) => void) => void) {
  const calls: string[] = [];
  const db = {
    initialize: vi.fn(async () => undefined),
    dropDatabase: vi.fn(async () => { calls.push('dropDatabase'); }),
  };
  const deleteTenantAllOverrides = vi.fn(async () => { calls.push('deleteOverrides'); });
  vi.doMock('child_process', () => ({
    execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: any, stdout: string, stderr: string) => void) => composeDown(cb)),
  }));
  vi.doMock('../services/fileLock', () => ({ withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn(), withTenantLock: <T>(_a: string, _t: string, fn: () => Promise<T>) => fn() }));
  vi.doMock('../config', () => ({
    loadConfig: () => ({ project: { name: 'T', prefix: 'test', db_prefix: 'test' } }),
    getAppsDir: () => appsDir,
    resolveAppDbPrefix: () => 'test',
  }));
  vi.doMock('../config/loader', () => ({ resolveCertResolver: () => ({ name: 'web', resolver: null }) }));
  vi.doMock('../adapters/database', () => ({ getDatabaseAdapter: () => db }));
  vi.doMock('../services/app', () => ({ getApp: vi.fn(async () => ({ id: 'demo', services: [] })), applyApp: vi.fn() }));
  vi.doMock('../services/envVars', () => ({ generateSharedEnvFile: vi.fn(), deleteTenantAllOverrides }));
  const { deleteTenant } = await import('../services/tenant');
  return { deleteTenant, db, deleteTenantAllOverrides, calls };
}

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
});
