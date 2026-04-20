import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockApp = {
  id: 'finalio',
  name: 'Finalio',
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
  loadConfig: () => ({ project: { name: 'kwoutr', prefix: 'kwoutr', db_prefix: 'kwoutr' } }),
  getAppsDir: () => '/tmp/apps',
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
  getTenantInfo: vi.fn(async (_appId: string, tenantId: string) => ({ appId: 'finalio', tenantId })),
  listTenants: vi.fn(async () => [{ appId: 'finalio', tenantId: 'daktela' }]),
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
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESTIC_PASSWORD = 'test';
    process.env.S3_ENDPOINT = 'http://s3';
    process.env.S3_BUCKET = 'bucket';
    process.env.S3_AK = 'ak';
    process.env.S3_SK = 'sk';
  });

  it('createBackup returns success:false when mysqldump throws Unknown database', async () => {
    mockDumpDatabase.mockRejectedValueOnce(new Error("mysqldump: Got error: 1049: \"Unknown database 'kwoutr_finalio_daktela'\""));

    const result = await createBackup('finalio', 'daktela');

    expect(mockDumpDatabase).toHaveBeenCalledOnce();
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('backupAllTenants reports failCount=1 when DB dump fails', async () => {
    mockDumpDatabase.mockRejectedValueOnce(new Error("Unknown database 'kwoutr_finalio_daktela'"));

    const result = await backupAllTenants('finalio');

    expect(result.successCount).toBe(0);
    expect(result.failCount).toBe(1);
    expect(result.success).toBe(false);
  });
});
