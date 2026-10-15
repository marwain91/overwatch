import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

let appsDir = '';
const tempPrefix = `bkruns${process.pid}`;
const tempRoot = `/tmp/${tempPrefix}-backups`;

const mockApp = {
  id: 'gadgets',
  name: 'Gadgets',
  domain_template: '*.example.com',
  registry: { type: 'ghcr' as const, url: 'ghcr.io', repository: 'x/y', auth: { type: 'token' as const } },
  services: [
    { name: 'web', backup: { enabled: true, paths: [{ container: '/data', local: 'data' }] } },
  ],
  backup: {
    enabled: true,
    provider: 's3' as const,
    restic_password_env: 'RESTIC_PASSWORD',
    s3: { endpoint_env: 'S3_ENDPOINT', bucket_env: 'S3_BUCKET', access_key_env: 'S3_AK', secret_key_env: 'S3_SK' },
  },
  default_image_tag: 'latest',
  createdAt: '', updatedAt: '',
};

const mockDump = vi.fn();
vi.mock('../config', () => ({
  loadConfig: () => ({ project: { name: 'acme', prefix: tempPrefix, db_prefix: 'acme' } }),
  getAppsDir: () => appsDir,
  resolveEnvValue: (s: string) => s,
  resolveAppDbPrefix: () => 'acme',
}));
vi.mock('../adapters/database', () => ({
  getDatabaseAdapter: () => ({ initialize: vi.fn(async () => {}), dumpDatabase: (...a: unknown[]) => mockDump(...a) }),
}));
vi.mock('../services/app', () => ({ getApp: vi.fn(async () => mockApp), listApps: vi.fn(async () => [mockApp]) }));
vi.mock('../services/tenantAppDef', () => ({ readTenantAppDef: vi.fn(async () => mockApp) }));
vi.mock('../services/docker', () => ({
  getTenantInfo: vi.fn(async (appId: string, tenantId: string) => ({ appId, tenantId })),
  listTenants: vi.fn(async () => []),
}));
const lockCalls: Array<{ key: string; opts: any }> = [];
let lockBusy = false;
vi.mock('../services/fileLock', async () => {
  const { ConflictError } = await import('../utils/httpErrors');
  return {
    withTenantLock: async (a: string, t: string, fn: () => Promise<unknown>, opts?: unknown) => {
      lockCalls.push({ key: `${a}/${t}`, opts });
      if (lockBusy) throw new ConflictError(`Tenant '${a}/${t}' is busy: another operation has held it for over 10s. Try again shortly.`);
      order.push('lock');
      try { return await fn(); } finally { order.push('unlock'); }
    },
  };
});

const behaviour = { copyOutError: null as null | string };
const order: string[] = [];
const stagedDirs: string[] = [];
vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], opts: any, cb?: Function) => {
    const done = typeof opts === 'function' ? opts : cb!;
    (async () => {
      if (cmd === 'restic' && args[0] === 'backup') {
        order.push('upload');
        stagedDirs.push(args[1]);
        const st = await fs.stat(args[1]);
        expect(st.mode & 0o777).toBe(0o700);
        return done(null, { stdout: '{"message_type":"summary","snapshot_id":"abc"}', stderr: '' });
      }
      if (cmd === 'docker' && args[0] === 'cp' && behaviour.copyOutError) {
        return done(Object.assign(new Error('Command failed'), { stderr: behaviour.copyOutError }));
      }
      return done(null, { stdout: '', stderr: '' });
    })();
  },
  spawn: vi.fn(),
}));

import { createBackup, backupAllTenants, sweepStaleBackupTempDirs } from '../services/backup';
import { eventBus } from '../services/eventBus';
import * as tenantStore from '../services/tenantStore';

async function addTenant(tenantId: string, env = 'DB_NAME=acme_gadgets_x\n') {
  const dir = path.join(appsDir, 'gadgets', 'tenants', tenantId);
  await fs.mkdir(dir, { recursive: true });
  if (env !== null) await fs.writeFile(path.join(dir, '.env'), env);
}

const events: Array<[string, any]> = [];
const onCompleted = (p: any) => events.push(['backup:completed', p]);
const onFailed = (p: any) => events.push(['backup:failed', p]);

beforeEach(async () => {
  appsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bkruns-'));
  mockDump.mockReset();
  mockDump.mockResolvedValue(undefined);
  lockCalls.length = 0;
  lockBusy = false;
  behaviour.copyOutError = null;
  order.length = 0;
  stagedDirs.length = 0;
  events.length = 0;
  eventBus.on('backup:completed', onCompleted);
  eventBus.on('backup:failed', onFailed);
  Object.assign(process.env, { RESTIC_PASSWORD: 'test', S3_ENDPOINT: 'https://s3', S3_BUCKET: 'b', S3_AK: 'ak', S3_SK: 'sk' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  eventBus.off('backup:completed', onCompleted);
  eventBus.off('backup:failed', onFailed);
  vi.restoreAllMocks();
  await fs.rm(appsDir, { recursive: true, force: true });
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('createBackup', () => {
  // A backup taken while a restore or update runs could capture a
  // half-restored database and still be marked successful.
  it('takes the tenant lock, with a short wait', async () => {
    await addTenant('t1');
    expect((await createBackup('gadgets', 't1')).success).toBe(true);
    expect(lockCalls).toHaveLength(1);
    expect(lockCalls[0].key).toBe('gadgets/t1');
    expect(lockCalls[0].opts.waitMs).toBeLessThanOrEqual(30_000);
  });

  // The upload can take an hour; updates and restarts of the tenant must not wait for it.
  it('releases the tenant lock once the data is captured, before the upload', async () => {
    await addTenant('t1');
    await createBackup('gadgets', 't1');
    expect(order).toEqual(['lock', 'unlock', 'upload']);
  });

  it('reports a busy tenant as a failed backup, with an event', async () => {
    await addTenant('t1');
    lockBusy = true;
    const r = await createBackup('gadgets', 't1');
    expect(r).toMatchObject({ success: false, busy: true });
    expect(r.error).toMatch(/busy/);
    expect(mockDump).not.toHaveBeenCalled();
    expect(events).toEqual([['backup:failed', { appId: 'gadgets', tenantId: 't1', reason: r.error }]]);
  });

  it('surfaces paths that could not be copied as incomplete', async () => {
    await addTenant('t1');
    behaviour.copyOutError = 'Error response from daemon: No such container: gadgets-t1-web';
    const r = await createBackup('gadgets', 't1');
    expect(r).toMatchObject({ success: true, incomplete: true, missingPaths: ['web:/data'] });
    expect(events).toEqual([['backup:completed', { appId: 'gadgets', tenantId: 't1', incomplete: true, missingPaths: ['web:/data'] }]]);
  });

  it('emits backup:completed for a clean backup and backup:failed for a failed one', async () => {
    await addTenant('t1');
    await createBackup('gadgets', 't1');
    mockDump.mockRejectedValueOnce(new Error('dump failed'));
    const failed = await createBackup('gadgets', 't1');
    expect(events).toEqual([
      ['backup:completed', { appId: 'gadgets', tenantId: 't1' }],
      ['backup:failed', { appId: 'gadgets', tenantId: 't1', reason: failed.error }],
    ]);
  });

  it('stages each backup in its own private temp dir, even within one millisecond', async () => {
    await addTenant('t1');
    await addTenant('t2');
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    await Promise.all([createBackup('gadgets', 't1'), createBackup('gadgets', 't2')]);
    expect(stagedDirs).toHaveLength(2);
    expect(new Set(stagedDirs).size).toBe(2);
    for (const d of stagedDirs) expect(path.basename(d)).toMatch(/^backup-.{6}$/);
  });
});

describe('backupAllTenants', () => {
  it('backs up every tenant directory of the app', async () => {
    await addTenant('t1');
    await addTenant('t2');
    const r = await backupAllTenants('gadgets');
    expect(r).toMatchObject({ success: true, successCount: 2, failCount: 0 });
    expect(events.at(-1)).toEqual(['backup:completed', { appId: 'gadgets' }]);
  });

  it('skips a directory without .env (not a tenant), like the tenant listing does', async () => {
    await addTenant('t1');
    await fs.mkdir(path.join(appsDir, 'gadgets', 'tenants', 'stray'), { recursive: true });
    const r = await backupAllTenants('gadgets');
    expect(r.results.map(x => x.tenantId)).toEqual(['t1']);
  });

  // listTenants() returned [] on any error (Docker down), which a scheduled
  // run reported as "0 succeeded, 0 failed".
  it('reports a tenant enumeration failure as a failed run', async () => {
    vi.spyOn(tenantStore, 'listTenantDirs').mockRejectedValue(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
    const r = await backupAllTenants('gadgets');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/list/i);
    expect(events).toEqual([['backup:failed', { appId: 'gadgets', reason: r.error }]]);
  });

  it('records each failed tenant and does not report the run as completed', async () => {
    await addTenant('t1');
    mockDump.mockRejectedValueOnce(new Error('dump failed'));
    const r = await backupAllTenants('gadgets');
    expect(r).toMatchObject({ success: false, failCount: 1 });
    expect(events.some(([n, p]) => n === 'backup:completed' && p.tenantId === undefined)).toBe(false);
  });

  it('runs one app at a time', async () => {
    await addTenant('t1');
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    mockDump.mockImplementationOnce(async () => { order.push('first:start'); await gate; order.push('first:end'); });
    mockDump.mockImplementationOnce(async () => { order.push('second:start'); });
    const first = backupAllTenants('gadgets');
    const second = backupAllTenants('gadgets');
    await new Promise(r => setTimeout(r, 30));
    expect(order).toEqual(['first:start']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
  });
});

describe('sweepStaleBackupTempDirs', () => {
  it('removes backup-/restore- staging dirs older than an hour, nothing else', async () => {
    await fs.mkdir(tempRoot, { recursive: true });
    const old = Date.now() / 1000 - 2 * 3600;
    for (const name of ['backup-old', 'restore-old', 'backup-new', 'other-old']) {
      await fs.mkdir(path.join(tempRoot, name, 'x'), { recursive: true });
      if (name.endsWith('-old')) await fs.utimes(path.join(tempRoot, name), old, old);
    }
    expect(await sweepStaleBackupTempDirs()).toBe(2);
    expect((await fs.readdir(tempRoot)).sort()).toEqual(['backup-new', 'other-old']);
  });

  it('is a no-op when the temp dir does not exist', async () => {
    expect(await sweepStaleBackupTempDirs()).toBe(0);
  });
});
