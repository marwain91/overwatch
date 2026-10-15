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

const execCalls: string[][] = [];
let forgetStdout = '';

vi.mock('../config', () => ({
  loadConfig: () => ({ project: { name: 'acme', prefix: 'acme', db_prefix: 'acme' } }),
  getAppsDir: () => '/tmp/apps',
  resolveEnvValue: (s: string) => s,
}));
vi.mock('../adapters/database', () => ({ getDatabaseAdapter: () => ({}) }));
vi.mock('../services/app', () => ({ getApp: vi.fn(async () => mockApp), listApps: vi.fn(async () => [mockApp]) }));
vi.mock('../services/docker', () => ({ getTenantInfo: vi.fn(), listTenants: vi.fn(async () => []) }));
vi.mock('child_process', () => ({
  execFile: (_cmd: string, args: string[], _opts: unknown, cb: Function) => {
    execCalls.push(args);
    cb(null, { stdout: args[0] === 'forget' ? forgetStdout : '', stderr: '' });
  },
  spawn: vi.fn(),
}));

import { pruneBackups } from '../services/backup';

const snap = (id: string, time: string, tags: string[]) => ({ id: id.repeat(8), short_id: id, time, tags, paths: ['/tmp/x'] });

describe('pruneBackups', () => {
  beforeEach(() => {
    execCalls.length = 0;
    forgetStdout = '';
    Object.assign(process.env, {
      RESTIC_PASSWORD: 'test', S3_ENDPOINT: 'http://s3', S3_BUCKET: 'bucket', S3_AK: 'ak', S3_SK: 'sk',
      OVERWATCH_ALLOW_INSECURE_S3: '1',
    });
  });

  // Every snapshot has a unique /tmp/.../backup-<ts> path, so restic's default
  // host+paths grouping makes each one its own group and nothing is forgotten.
  // Grouping by the tag set needs the app: filter, or one app's policy would
  // apply to every app sharing the repository.
  it("groups by tags and only touches this app's snapshots", async () => {
    expect(await pruneBackups('gadgets')).toMatchObject({ success: true });
    expect(execCalls.find(a => a[0] === 'forget')).toEqual([
      'forget', '--tag', 'app:gadgets', '--group-by', 'tags',
      '--keep-daily', '7', '--keep-weekly', '4', '--keep-monthly', '12', '--prune',
    ]);
  });

  it('passes an explicit policy, including zeros', async () => {
    await pruneBackups('gadgets', { keepDaily: 3, keepWeekly: 0, keepMonthly: 6 });
    const args = execCalls.find(a => a[0] === 'forget')!;
    expect(args).toEqual(expect.arrayContaining(['--keep-daily', '3', '--keep-weekly', '0', '--keep-monthly', '6']));
  });

  it('refuses a policy that keeps nothing', async () => {
    await expect(pruneBackups('gadgets', { keepDaily: 0, keepWeekly: 0, keepMonthly: 0 })).rejects.toMatchObject({ status: 400 });
    expect(execCalls.some(a => a[0] === 'forget')).toBe(false);
  });

  it('dry run lists what would be removed without --prune', async () => {
    forgetStdout = JSON.stringify([
      {
        tags: ['app:gadgets', 'tenant:t1'],
        keep: [snap('aaaaaaaa', '2026-01-03T00:00:00Z', ['app:gadgets', 'tenant:t1'])],
        remove: [snap('bbbbbbbb', '2026-01-01T00:00:00Z', ['app:gadgets', 'tenant:t1'])],
      },
      { tags: ['app:gadgets', 'tenant:t2'], keep: [snap('cccccccc', '2026-01-02T00:00:00Z', ['app:gadgets', 'tenant:t2'])], remove: null },
    ]);
    const r = await pruneBackups('gadgets', { keepDaily: 1 }, { dryRun: true });
    const args = execCalls.find(a => a[0] === 'forget')!;
    expect(args).toContain('--dry-run');
    expect(args).toContain('--json');
    expect(args).not.toContain('--prune');
    expect(r).toMatchObject({ success: true, dryRun: true, keepCount: 2, removeCount: 1 });
    expect(r.remove).toEqual([
      { id: 'bbbbbbbb'.repeat(8), shortId: 'bbbbbbbb', time: '2026-01-01T00:00:00Z', tenantId: 't1', tags: ['app:gadgets', 'tenant:t1'] },
    ]);
  });
});
