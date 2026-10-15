import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

let appsDir = '';

const mockApp = {
  id: 'gadgets',
  name: 'Gadgets',
  domain_template: '*.example.com',
  registry: { type: 'ghcr' as const, url: 'ghcr.io', repository: 'x/y', auth: { type: 'token' as const } },
  services: [],
  backup: {
    enabled: true,
    provider: 's3' as const,
    restic_password_env: 'RESTIC_PASSWORD',
    s3: { endpoint_env: 'S3_ENDPOINT', bucket_env: 'S3_BUCKET', access_key_env: 'S3_AK', secret_key_env: 'S3_SK' },
  },
  default_image_tag: 'latest',
  createdAt: '', updatedAt: '',
};

const mockDumpDatabase = vi.fn();

vi.mock('../config', () => ({
  loadConfig: () => ({ project: { name: 'acme', prefix: 'acme', db_prefix: 'acme' } }),
  getAppsDir: () => appsDir,
  resolveEnvValue: (s: string) => s,
}));

vi.mock('../adapters/database', () => ({
  getDatabaseAdapter: () => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    dumpDatabase: mockDumpDatabase,
  }),
}));

vi.mock('../services/app', () => ({
  getApp: vi.fn(async () => mockApp),
  listApps: vi.fn(async () => [mockApp]),
}));

vi.mock('../services/docker', () => ({
  getTenantInfo: vi.fn(async (_appId: string, tenantId: string) => ({ appId: 'gadgets', tenantId })),
  listTenants: vi.fn(async () => [{ appId: 'gadgets', tenantId: 'daktela' }]),
}));

vi.mock('../services/fileLock', () => ({
  withTenantLock: (_a: string, _t: string, fn: () => Promise<unknown>) => fn(),
}));

vi.mock('child_process', () => ({
  execFile: (_cmd: string, _args: string[], _opts: any, cb: Function) => {
    // 'restic cat config' → succeeds (repo initialized); anything else also succeeds
    cb(null, { stdout: '', stderr: '' });
  },
  spawn: vi.fn(),
}));

import { createBackup, backupAllTenants } from '../services/backup';

describe('Scheduler silent-failure regression', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // backupAllTenants enumerates the tenant directories (with a .env).
    appsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bksilent-'));
    const dir = path.join(appsDir, 'gadgets', 'tenants', 'daktela');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, '.env'), 'IMAGE_TAG=1\n');
    process.env.RESTIC_PASSWORD = 'test';
    process.env.S3_ENDPOINT = 'http://s3';
    process.env.S3_BUCKET = 'bucket';
    process.env.S3_AK = 'ak';
    process.env.S3_SK = 'sk';
  });

  afterEach(async () => {
    await fs.rm(appsDir, { recursive: true, force: true });
  });

  it('createBackup returns success:false when mysqldump throws Unknown database', async () => {
    mockDumpDatabase.mockRejectedValueOnce(new Error("mysqldump: Got error: 1049: \"Unknown database 'acme_gadgets_daktela'\""));

    const result = await createBackup('gadgets', 'daktela');

    expect(mockDumpDatabase).toHaveBeenCalledOnce();
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('backupAllTenants reports failCount=1 when DB dump fails', async () => {
    mockDumpDatabase.mockRejectedValueOnce(new Error("Unknown database 'acme_gadgets_daktela'"));

    const result = await backupAllTenants('gadgets');

    expect(result.successCount).toBe(0);
    expect(result.failCount).toBe(1);
    expect(result.success).toBe(false);
  });
});
