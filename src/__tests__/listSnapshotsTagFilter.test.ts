import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const execCalls: Array<{ cmd: string; args: string[] }> = [];

vi.mock('../config', () => ({
  loadConfig: () => ({ project: { name: 'acme', prefix: 'acme', db_prefix: 'acme' } }),
  getAppsDir: () => '/tmp/apps',
  resolveEnvValue: (s: string) => s,
}));

vi.mock('../adapters/database', () => ({
  getDatabaseAdapter: () => ({ initialize: vi.fn(), dumpDatabase: vi.fn() }),
}));

vi.mock('../services/app', () => ({
  getApp: vi.fn(async () => mockApp),
  listApps: vi.fn(async () => [mockApp]),
}));

vi.mock('../services/docker', () => ({
  getTenantInfo: vi.fn(),
  listTenants: vi.fn(async () => []),
}));

vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], _opts: any, cb: Function) => {
    execCalls.push({ cmd, args });
    // restic cat config → succeed (repo initialized)
    // restic snapshots → return empty array
    if (args[0] === 'snapshots') {
      cb(null, { stdout: '[]', stderr: '' });
    } else {
      cb(null, { stdout: '', stderr: '' });
    }
  },
  spawn: vi.fn(),
}));

import { listSnapshots } from '../services/backup';

describe('listSnapshots tag filter', () => {
  beforeEach(() => {
    execCalls.length = 0;
    process.env.RESTIC_PASSWORD = 'test';
    process.env.S3_ENDPOINT = 'http://s3';
    process.env.S3_BUCKET = 'bucket';
    process.env.S3_AK = 'ak';
    process.env.S3_SK = 'sk';
    process.env.OVERWATCH_ALLOW_INSECURE_S3 = '1';
  });

  it('filters by app: tag only when no tenantId is given', async () => {
    await listSnapshots('gadgets');
    const snapshotsCall = execCalls.find(c => c.args[0] === 'snapshots');
    expect(snapshotsCall).toBeDefined();
    expect(snapshotsCall!.args).toEqual(['snapshots', '--json', '--tag', 'app:gadgets']);
  });

  it('ANDs app: and tenant: tags via comma-separated single --tag', async () => {
    await listSnapshots('gadgets', 'daktela');
    const snapshotsCall = execCalls.find(c => c.args[0] === 'snapshots');
    expect(snapshotsCall).toBeDefined();
    // Single --tag flag, comma-joined values — restic ANDs comma-separated values
    // within one --tag (multiple --tag flags would OR, which is what we want to avoid).
    expect(snapshotsCall!.args).toEqual(['snapshots', '--json', '--tag', 'app:gadgets,tenant:daktela']);
    const tagFlagCount = snapshotsCall!.args.filter(a => a === '--tag').length;
    expect(tagFlagCount).toBe(1);
  });
});
