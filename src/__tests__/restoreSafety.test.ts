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

/** Every step that changes something, in order. */
const log: string[] = [];
const db = {
  initialize: vi.fn(async () => {}),
  dumpDatabase: vi.fn(async (_id: string, out: string) => { log.push('dump'); await fs.writeFile(out, '-- live'); }),
  resetDatabase: vi.fn(async (id: string) => { log.push(`reset:${id}`); }),
  restoreDatabase: vi.fn(async (id: string, file: string) => { log.push(`import:${id}:${(await fs.readFile(file, 'utf-8')).trim()}`); }),
};

vi.mock('../config', () => ({
  loadConfig: () => ({ project: { name: 'acme', prefix: `rsafe${process.pid}`, db_prefix: 'acme' } }),
  getAppsDir: () => appsDir,
  resolveEnvValue: (s: string) => s,
  resolveAppDbPrefix: () => 'acme',
}));
vi.mock('../adapters/database', () => ({ getDatabaseAdapter: () => db }));
vi.mock('../services/app', () => ({ getApp: vi.fn(async () => mockApp), listApps: vi.fn(async () => [mockApp]) }));
vi.mock('../services/tenantAppDef', () => ({ readTenantAppDef: vi.fn(async () => mockApp) }));
vi.mock('../services/docker', () => ({ getTenantInfo: vi.fn(async (appId: string, tenantId: string) => ({ appId, tenantId })) }));
vi.mock('../services/fileLock', () => ({ withTenantLock: (_a: string, _t: string, fn: () => Promise<unknown>) => fn() }));

const SNAP = 'abcdef12';
const SNAP_FULL = SNAP.repeat(8);
const SAFETY = '5afe0001';
const SAFETY_FULL = SAFETY.repeat(8);

const world = {
  snapshots: {} as Record<string, { id: string; short_id: string; tags?: string[] }[]>,
  running: true,
  failSafetyBackup: false,
  safetyLsError: null as null | string,
  cpFail: [] as string[], // snapshot ids whose path copy fails
  failStart: false,
  failStop: false,
};
const resticRestores: string[] = [];
const backupTags: string[][] = [];

vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], opts: any, cb?: Function) => {
    const done = typeof opts === 'function' ? opts : cb!;
    const fail = (msg: string, stderr = '') => done(Object.assign(new Error(msg), { stderr }));
    (async () => {
      if (cmd === 'restic' && args[0] === 'snapshots' && args.length === 3) {
        return done(null, { stdout: JSON.stringify(world.snapshots[args[2]] ?? []), stderr: '' });
      }
      if (cmd === 'restic' && args[0] === 'restore') {
        const id = args[1];
        resticRestores.push(id);
        const target = args[args.indexOf('--target') + 1];
        const dir = path.join(target, 'tmp', 'staged');
        const isSafety = id === SAFETY_FULL;
        await fs.mkdir(path.join(dir, isSafety ? 't1' : 'src', 'data'), { recursive: true });
        await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify({ appId: 'gadgets', tenants: [isSafety ? 't1' : 'src'] }));
        await fs.writeFile(path.join(dir, isSafety ? 't1' : 'src', 'database.sql'), isSafety ? '-- safety' : '-- snapshot');
        await fs.writeFile(path.join(dir, isSafety ? 't1' : 'src', 'data', 'f'), id);
        log.push(`restic-restore:${isSafety ? 'safety' : 'snapshot'}`);
        return done(null, { stdout: '', stderr: '' });
      }
      if (cmd === 'restic' && args[0] === 'backup') {
        if (world.failSafetyBackup) return fail('restic backup failed', 'Fatal: unable to save snapshot');
        backupTags.push(args.filter((_a, i) => args[i - 1] === '--tag'));
        log.push('safety-backup');
        return done(null, { stdout: `{"message_type":"summary","snapshot_id":"${SAFETY_FULL}"}`, stderr: '' });
      }
      if (cmd === 'find') {
        const out: string[] = [];
        const walk = async (d: string) => {
          for (const e of await fs.readdir(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) await walk(p); else if (e.name === 'metadata.json') out.push(p);
          }
        };
        await walk(args[0]);
        return done(null, { stdout: out.join('\n'), stderr: '' });
      }
      if (cmd === 'docker' && args[0] === 'compose') {
        const sub = args[args.indexOf('-f') + 2];
        if (sub === 'ps') return done(null, { stdout: world.running ? 'c0ffee\n' : '', stderr: '' });
        if (sub === 'stop') {
          if (world.failStop) return fail('compose stop failed');
          log.push('stop');
        }
        if (sub === 'up') {
          log.push(`up:${args.slice(args.indexOf('up')).join(' ')}`);
          if (world.failStart) return fail('compose up failed', 'migrator exited 1');
        }
        return done(null, { stdout: '', stderr: '' });
      }
      if (cmd === 'docker' && args.includes('ls')) {
        if (world.safetyLsError) return fail('Command failed', world.safetyLsError);
        return done(null, { stdout: 'f\n', stderr: '' });
      }
      if (cmd === 'docker' && args[0] === 'cp') {
        if (args[1].includes(':')) return done(null, { stdout: '', stderr: '' }); // copy out (safety backup)
        const content = await fs.readFile(path.join(args[1].replace(/\/\.$/, ''), 'f'), 'utf-8').catch(() => '');
        if (world.cpFail.includes(content)) return fail('docker cp failed', 'no space left on device');
        log.push(`cp:${content === SAFETY_FULL ? 'safety' : 'snapshot'}:${args[2]}`);
        return done(null, { stdout: '', stderr: '' });
      }
      if (cmd === 'docker' && args[0] === 'exec') log.push(`exec:${args.slice(2).join(' ')}`);
      return done(null, { stdout: '', stderr: '' });
    })();
  },
  spawn: vi.fn(),
}));

import { assertSnapshotOfApp, restoreBackup, restoreBackupLocked } from '../services/backup';

const owned = (tags: string[] | undefined) => [{ id: SNAP_FULL, short_id: SNAP, ...(tags ? { tags } : {}) }];

beforeEach(async () => {
  appsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rsafe-'));
  for (const t of ['t1', 'src']) {
    const dir = path.join(appsDir, 'gadgets', 'tenants', t);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, '.env'), 'IMAGE_TAG=1\n');
  }
  log.length = 0;
  resticRestores.length = 0;
  backupTags.length = 0;
  Object.assign(world, { running: true, failSafetyBackup: false, safetyLsError: null, cpFail: [], failStart: false, failStop: false });
  world.snapshots = {
    [SNAP]: owned(['app:gadgets', 'tenant:t1']),
    [SAFETY_FULL]: [{ id: SAFETY_FULL, short_id: SAFETY, tags: ['app:gadgets', 'pre-restore', 'tenant:t1'] }],
  };
  for (const fn of Object.values(db)) fn.mockClear();
  Object.assign(process.env, { RESTIC_PASSWORD: 'pw', S3_ENDPOINT: 'https://s3', S3_BUCKET: 'b', S3_AK: 'ak', S3_SK: 'sk' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(appsDir, { recursive: true, force: true });
});

describe('restore checks that the snapshot belongs to the app and tenant', () => {
  it("refuses another app's snapshot as not found, before downloading anything", async () => {
    world.snapshots[SNAP] = owned(['app:other', 'tenant:t1']);
    await expect(restoreBackup('gadgets', SNAP, 't1')).rejects.toMatchObject({ status: 404 });
    expect(resticRestores).toEqual([]);
    expect(log).toEqual([]);
  });

  it('refuses an id that matches no snapshot', async () => {
    world.snapshots[SNAP] = [];
    await expect(restoreBackup('gadgets', SNAP, 't1')).rejects.toMatchObject({ status: 404 });
  });

  it('refuses an untagged legacy snapshot with a clear message', async () => {
    world.snapshots[SNAP] = owned(undefined);
    await expect(restoreBackup('gadgets', SNAP, 't1')).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/no app tag/i) });
    expect(log).toEqual([]);
  });

  it("refuses another tenant's snapshot in place unless cross-tenant restore is asked for", async () => {
    world.snapshots[SNAP] = owned(['app:gadgets', 'tenant:src']);
    await expect(restoreBackup('gadgets', SNAP, 't1')).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/tenant 'src'.*allowCrossTenant/) });
    expect(log).toEqual([]);
    const r = await restoreBackup('gadgets', SNAP, 't1', { allowCrossTenant: true });
    expect(r.success).toBe(true);
  });

  it('treats a snapshot without a tenant tag as another tenant', async () => {
    world.snapshots[SNAP] = owned(['app:gadgets']);
    await expect(restoreBackup('gadgets', SNAP, 't1')).rejects.toMatchObject({ status: 400 });
  });

  it('allows any tenant of the app for create-from-backup', async () => {
    world.snapshots[SNAP] = owned(['app:gadgets', 'tenant:src']);
    const r = await restoreBackupLocked('gadgets', SNAP, 't1', { createNew: true, newDomain: 't1.example.com', containersStopped: true });
    expect(r.success).toBe(true);
  });

  it('restores the full id the short id resolved to', async () => {
    await restoreBackup('gadgets', SNAP, 't1');
    expect(resticRestores[0]).toBe(SNAP_FULL);
  });
});

describe('in-place restore safety sequence', () => {
  it('takes a pre-restore snapshot, stops the tenant, resets and imports, copies, then starts it again', async () => {
    const r = await restoreBackup('gadgets', SNAP, 't1');
    expect(r).toMatchObject({ success: true, safetySnapshotId: SAFETY_FULL });
    expect(backupTags).toEqual([['app:gadgets', 'tenant:t1', 'pre-restore']]);
    expect(log).toEqual([
      'restic-restore:snapshot',
      'dump', 'safety-backup',
      'stop',
      'reset:gadgets_t1',
      'import:gadgets_t1:-- snapshot',
      'cp:snapshot:gadgets-t1-web:/data/',
      'up:up -d --no-recreate',
    ]);
  });

  it('aborts with nothing changed when the safety snapshot fails', async () => {
    world.failSafetyBackup = true;
    const r = await restoreBackup('gadgets', SNAP, 't1');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/safety snapshot.*nothing was changed/i);
    expect(log.filter(l => /^(stop|reset|import|cp:|up)/.test(l))).toEqual([]);
  });

  it('aborts when the safety snapshot could not save every path', async () => {
    world.safetyLsError = 'Error response from daemon: container gadgets-t1-web is not running';
    const r = await restoreBackup('gadgets', SNAP, 't1');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/web:\/data/);
    expect(log.filter(l => /^(stop|reset|import|cp:|up)/.test(l))).toEqual([]);
  });

  it('leaves a tenant that was not running stopped', async () => {
    world.running = false;
    const r = await restoreBackup('gadgets', SNAP, 't1');
    expect(r.success).toBe(true);
    expect(log.some(l => l === 'stop' || l.startsWith('up:'))).toBe(false);
  });

  it('aborts before any change when the tenant cannot be stopped', async () => {
    world.failStop = true;
    const r = await restoreBackup('gadgets', SNAP, 't1');
    expect(r.success).toBe(false);
    expect(log.some(l => l.startsWith('reset') || l.startsWith('import'))).toBe(false);
  });

  it('puts the safety snapshot back when the import fails, and reports both', async () => {
    db.restoreDatabase.mockImplementationOnce(async () => { log.push('import-failed'); throw new Error('ERROR 1064 near ...'); });
    const r = await restoreBackup('gadgets', SNAP, 't1');
    expect(r).toMatchObject({ success: false, rolledBack: true, safetySnapshotId: SAFETY_FULL });
    expect(r.error).toMatch(/database import failed/i);
    expect(r.error).toMatch(/rolled back.*5afe0001/i);
    expect(r.error).not.toMatch(/1064/);
    expect(log.slice(log.indexOf('import-failed'))).toEqual([
      'import-failed',
      'restic-restore:safety',
      'reset:gadgets_t1',
      'import:gadgets_t1:-- safety',
      'cp:safety:gadgets-t1-web:/data/',
      'up:up -d --no-recreate',
    ]);
  });

  it('rolls back when a path copy fails after the reset', async () => {
    world.cpFail = [SNAP_FULL];
    const r = await restoreBackup('gadgets', SNAP, 't1');
    expect(r).toMatchObject({ success: false, rolledBack: true });
    expect(r.error).toMatch(/\/data/);
    expect(log).toContain('import:gadgets_t1:-- safety');
  });

  it('reports a failed rollback and leaves the tenant stopped', async () => {
    db.restoreDatabase.mockRejectedValue(new Error('server gone'));
    try {
      const r = await restoreBackup('gadgets', SNAP, 't1');
      expect(r).toMatchObject({ success: false, rolledBack: false, safetySnapshotId: SAFETY_FULL });
      expect(r.error).toMatch(/rolling back.*also failed/i);
      expect(r.error).toMatch(/5afe0001/);
      expect(log.some(l => l.startsWith('up:'))).toBe(false);
    } finally {
      db.restoreDatabase.mockReset();
      db.restoreDatabase.mockImplementation(async (id: string, file: string) => { log.push(`import:${id}:${(await fs.readFile(file, 'utf-8')).trim()}`); });
    }
  });

  it('reports a tenant that does not start after a successful restore', async () => {
    world.failStart = true;
    const r = await restoreBackup('gadgets', SNAP, 't1');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/restored.*failed to start/i);
    expect(r.safetySnapshotId).toBe(SAFETY_FULL);
  });

  it('explains a Postgres dump that names another tenant role', async () => {
    db.restoreDatabase.mockImplementationOnce(async () => { throw new Error('psql restore exited with code 3: ERROR:  must be able to SET ROLE "acme_gadgets_src"'); });
    const r = await restoreBackupLocked('gadgets', SNAP, 't1', { createNew: true, newDomain: 'x.example.com', containersStopped: true });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/older Overwatch version/);
  });
});

describe('create-from-backup keeps its sequence', () => {
  it('takes no safety snapshot, does not reset, stop or start', async () => {
    const r = await restoreBackupLocked('gadgets', SNAP, 't1', { createNew: true, newDomain: 't1.example.com', containersStopped: true });
    expect(r.success).toBe(true);
    expect(log).toEqual(['restic-restore:snapshot', 'import:gadgets_t1:-- snapshot', 'cp:snapshot:gadgets-t1-web:/data/']);
  });
});

describe('assertSnapshotOfApp (create-from-backup pre-check)', () => {
  it("accepts any tenant's snapshot of the app", async () => {
    world.snapshots[SNAP] = owned(['app:gadgets', 'tenant:src']);
    await expect(assertSnapshotOfApp('gadgets', SNAP)).resolves.toBeUndefined();
  });

  it("refuses another app's snapshot, an unknown id and an untagged one", async () => {
    world.snapshots[SNAP] = owned(['app:other', 'tenant:src']);
    await expect(assertSnapshotOfApp('gadgets', SNAP)).rejects.toMatchObject({ status: 404 });
    world.snapshots[SNAP] = [];
    await expect(assertSnapshotOfApp('gadgets', SNAP)).rejects.toMatchObject({ status: 404 });
    world.snapshots[SNAP] = owned(undefined);
    await expect(assertSnapshotOfApp('gadgets', SNAP)).rejects.toMatchObject({ status: 400 });
    expect(resticRestores).toEqual([]);
  });
});
