import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockApp = {
  id: 'gadgets', name: 'Gadgets', domain_template: '*.example.com',
  registry: { type: 'ghcr' as const, url: 'ghcr.io', repository: 'x/y', auth: { type: 'token' as const } },
  services: [],
  backup: {
    enabled: true, provider: 's3' as const, restic_password_env: 'RESTIC_PASSWORD',
    s3: { endpoint_env: 'S3_ENDPOINT', bucket_env: 'S3_BUCKET', access_key_env: 'S3_AK', secret_key_env: 'S3_SK' },
  },
  default_image_tag: 'latest', createdAt: '', updatedAt: '',
};

const execCalls: Array<{ cmd: string; args: string[]; opts: any }> = [];
let snapshotsError: any = null;

vi.mock('../config', () => ({
  loadConfig: () => ({ project: { name: 'acme', prefix: 'acme', db_prefix: 'acme' } }),
  getAppsDir: () => '/tmp/apps',
  resolveEnvValue: (s: string) => s,
}));
vi.mock('../adapters/database', () => ({ getDatabaseAdapter: () => ({ initialize: vi.fn(), dumpDatabase: vi.fn() }) }));
vi.mock('../services/app', () => ({ getApp: vi.fn(async () => mockApp), listApps: vi.fn(async () => [mockApp]) }));
vi.mock('../services/docker', () => ({ getTenantInfo: vi.fn(), listTenants: vi.fn(async () => []) }));
vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], opts: any, cb: Function) => {
    execCalls.push({ cmd, args, opts });
    if (args[0] === 'snapshots' && snapshotsError) return cb(snapshotsError);
    cb(null, { stdout: args[0] === 'snapshots' ? '[]' : '', stderr: '' });
  },
  spawn: vi.fn(),
}));

import { listSnapshots, pruneBackups } from '../services/backup';

beforeEach(() => {
  execCalls.length = 0;
  snapshotsError = null;
  process.env.RESTIC_PASSWORD = 'test';
  process.env.S3_ENDPOINT = 'http://s3';
  process.env.S3_BUCKET = 'bucket';
  process.env.S3_AK = 'ak';
  process.env.S3_SK = 'sk';
  process.env.OVERWATCH_ALLOW_INSECURE_S3 = '1';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('restic invocations', () => {
  it('list snapshots with a timeout and a generous maxBuffer', async () => {
    await listSnapshots('gadgets');
    const call = execCalls.find(c => c.args[0] === 'snapshots')!;
    expect(call.opts.timeout).toBeGreaterThan(0);
    expect(call.opts.maxBuffer).toBeGreaterThanOrEqual(16 * 1024 * 1024);
  });

  it('do not silently report no snapshots when the output overflows maxBuffer', async () => {
    snapshotsError = Object.assign(new RangeError('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
    await expect(listSnapshots('gadgets')).rejects.toThrow(/maxBuffer/);
  });

  it('give prune a timeout and maxBuffer too', async () => {
    await pruneBackups('gadgets');
    const call = execCalls.find(c => c.args[0] === 'forget')!;
    expect(call.opts.timeout).toBeGreaterThan(0);
    expect(call.opts.maxBuffer).toBeGreaterThan(0);
  });
});
