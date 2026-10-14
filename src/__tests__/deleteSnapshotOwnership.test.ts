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
let snapshotsJson = '[]';

vi.mock('../config', () => ({
  loadConfig: () => ({ project: { name: 'acme', prefix: 'acme', db_prefix: 'acme' } }),
  getAppsDir: () => '/tmp/apps',
  resolveEnvValue: (s: string) => s,
}));
vi.mock('../adapters/database', () => ({ getDatabaseAdapter: () => ({}) }));
vi.mock('../services/app', () => ({ getApp: vi.fn(async () => mockApp), listApps: vi.fn(async () => [mockApp]) }));
vi.mock('../services/docker', () => ({ getTenantInfo: vi.fn(), listTenants: vi.fn(async () => []) }));
vi.mock('child_process', () => ({
  // restic ignores --tag filters when an explicit snapshot id is given, so the
  // mock does too: `snapshots --json <id>` returns the snapshot whatever its tags.
  execFile: (_cmd: string, args: string[], _opts: unknown, cb: Function) => {
    execCalls.push(args);
    cb(null, { stdout: args[0] === 'snapshots' ? snapshotsJson : '', stderr: '' });
  },
  spawn: vi.fn(),
}));

import { deleteSnapshot } from '../services/backup';

const snap = (tags: string[]) => JSON.stringify([{ id: 'abcdef12'.repeat(8), short_id: 'abcdef12', tags }]);

describe('deleteSnapshot ownership (apps may share a restic repository)', () => {
  beforeEach(() => {
    execCalls.length = 0;
    Object.assign(process.env, {
      RESTIC_PASSWORD: 'test', S3_ENDPOINT: 'http://s3', S3_BUCKET: 'bucket', S3_AK: 'ak', S3_SK: 'sk',
      OVERWATCH_ALLOW_INSECURE_S3: '1',
    });
  });

  it("refuses to forget another app's snapshot", async () => {
    snapshotsJson = snap(['app:other', 'tenant:t1']);
    await expect(deleteSnapshot('gadgets', 'abcdef12')).rejects.toMatchObject({ status: 404 });
    expect(execCalls.some(a => a[0] === 'forget')).toBe(false);
  });

  it('refuses an id that matches no snapshot', async () => {
    snapshotsJson = '[]';
    await expect(deleteSnapshot('gadgets', 'abcdef12')).rejects.toMatchObject({ status: 404 });
    expect(execCalls.some(a => a[0] === 'forget')).toBe(false);
  });

  it("forgets the app's own snapshot", async () => {
    snapshotsJson = snap(['app:gadgets', 'tenant:t1']);
    expect(await deleteSnapshot('gadgets', 'abcdef12')).toEqual({ success: true });
    expect(execCalls.find(a => a[0] === 'forget')).toEqual(['forget', 'abcdef12']);
  });
});
