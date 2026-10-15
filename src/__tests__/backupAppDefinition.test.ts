import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

let appsDir = '';

// The global definition and the tenant's frozen snapshot point at different
// repositories (the tenant has not been updated since the bucket moved).
const backupBlock = (bucketEnv: string) => ({
  enabled: true,
  provider: 's3' as const,
  restic_password_env: 'RESTIC_PASSWORD',
  s3: { endpoint_env: 'S3_ENDPOINT', bucket_env: bucketEnv, access_key_env: 'S3_AK', secret_key_env: 'S3_SK' },
});
const base = {
  id: 'gadgets', name: 'Gadgets', domain_template: '*.example.com',
  registry: { type: 'ghcr' as const, url: 'ghcr.io', repository: 'x/y', auth: { type: 'token' as const } },
  default_image_tag: 'latest', createdAt: '', updatedAt: '',
};
const globalApp = { ...base, services: [], backup: backupBlock('GLOBAL_BUCKET') };
const tenantApp = { ...base, services: [], backup: backupBlock('TENANT_BUCKET') };

vi.mock('../config', () => ({
  loadConfig: () => ({ project: { name: 'acme', prefix: 'acme', db_prefix: 'acme' } }),
  getAppsDir: () => appsDir,
  resolveEnvValue: (s: string) => s,
  resolveAppDbPrefix: () => 'acme',
}));
const dbAdapter = { initialize: vi.fn(async () => {}), dumpDatabase: vi.fn(async () => {}), restoreDatabase: vi.fn(async () => {}), resetDatabase: vi.fn(async () => {}) };
vi.mock('../adapters/database', () => ({ getDatabaseAdapter: () => dbAdapter }));
vi.mock('../services/app', () => ({ getApp: vi.fn(async () => globalApp), listApps: vi.fn(async () => [globalApp]) }));
const readTenantAppDef = vi.fn(async (..._a: unknown[]): Promise<any> => tenantApp);
vi.mock('../services/tenantAppDef', () => ({ readTenantAppDef: (...a: unknown[]) => readTenantAppDef(...a) }));
vi.mock('../services/docker', () => ({ getTenantInfo: vi.fn(async (appId: string, tenantId: string) => ({ appId, tenantId })) }));
vi.mock('../services/fileLock', () => ({ withTenantLock: (_a: string, _t: string, fn: () => Promise<unknown>) => fn() }));

const resticRepos: Array<{ cmd: string; repo: string }> = [];
vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], opts: any, cb: Function) => {
    if (cmd === 'restic') resticRepos.push({ cmd: args[0], repo: opts?.env?.RESTIC_REPOSITORY });
    if (cmd === 'restic' && args[0] === 'snapshots') {
      return cb(null, { stdout: JSON.stringify([{ id: 'abcdef12'.repeat(8), short_id: 'abcdef12', time: '2026-01-01T00:00:00Z', tags: ['app:gadgets', 'tenant:t1'] }]), stderr: '' });
    }
    if (cmd === 'restic' && args[0] === 'backup') return cb(null, { stdout: '{"message_type":"summary","snapshot_id":"abc"}', stderr: '' });
    cb(null, { stdout: '', stderr: '' });
  },
  spawn: vi.fn(),
}));

import { createBackup, listSnapshots, restoreBackupLocked } from '../services/backup';

beforeEach(async () => {
  appsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bkdef-'));
  const dir = path.join(appsDir, 'gadgets', 'tenants', 't1');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '.env'), 'IMAGE_TAG=1\n');
  resticRepos.length = 0;
  readTenantAppDef.mockImplementation(async () => tenantApp);
  Object.assign(process.env, {
    RESTIC_PASSWORD: 'pw', S3_ENDPOINT: 'https://s3', GLOBAL_BUCKET: 'global-bucket', TENANT_BUCKET: 'tenant-bucket', S3_AK: 'ak', S3_SK: 'sk',
  });
});
afterEach(async () => { await fs.rm(appsDir, { recursive: true, force: true }); });

const TENANT_REPO = 's3:https://s3/tenant-bucket';
const GLOBAL_REPO = 's3:https://s3/global-bucket';

describe("per-tenant backup operations use the tenant's own definition", () => {
  it('createBackup checks and writes the same (tenant) repository', async () => {
    expect((await createBackup('gadgets', 't1')).success).toBe(true);
    expect(resticRepos.map(r => r.repo)).toEqual(resticRepos.map(() => TENANT_REPO));
    expect(resticRepos.map(r => r.cmd)).toEqual(['cat', 'backup']);
  });

  it("listSnapshots of a tenant reads the tenant's repository", async () => {
    await listSnapshots('gadgets', 't1');
    expect(readTenantAppDef).toHaveBeenCalledWith('gadgets', 't1');
    expect(new Set(resticRepos.map(r => r.repo))).toEqual(new Set([TENANT_REPO]));
  });

  it('listSnapshots of the whole app reads the global repository', async () => {
    await listSnapshots('gadgets');
    expect(new Set(resticRepos.map(r => r.repo))).toEqual(new Set([GLOBAL_REPO]));
  });
});

describe('restore', () => {
  it("reads the snapshot from the target tenant's repository", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await restoreBackupLocked('gadgets', 'abcdef12', 't1');
    expect(readTenantAppDef).toHaveBeenCalledWith('gadgets', 't1');
    expect(resticRepos.some(r => r.cmd === 'restore')).toBe(true);
    expect(new Set(resticRepos.map(r => r.repo))).toEqual(new Set([TENANT_REPO]));
  });
});
