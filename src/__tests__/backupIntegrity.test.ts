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

const mockDump = vi.fn().mockResolvedValue(undefined);
const mockRestore = vi.fn().mockResolvedValue(undefined);
vi.mock('../config', () => ({
  loadConfig: () => ({ project: { name: 'acme', prefix: 'acme', db_prefix: 'acme' } }),
  getAppsDir: () => appsDir,
  resolveEnvValue: (s: string) => s,
  resolveAppDbPrefix: () => 'acme',
}));
vi.mock('../adapters/database', () => ({
  getDatabaseAdapter: () => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    dumpDatabase: mockDump,
    restoreDatabase: mockRestore,
  }),
}));
vi.mock('../services/app', () => ({
  getApp: vi.fn(async () => mockApp),
  listApps: vi.fn(async () => [mockApp]),
}));
const mockReadTenantAppDef = vi.fn(async (..._a: unknown[]): Promise<any> => mockApp);
vi.mock('../services/tenantAppDef', () => ({ readTenantAppDef: (...a: unknown[]) => mockReadTenantAppDef(...a) }));
const lockLog: string[] = [];
vi.mock('../services/fileLock', () => ({
  withTenantLock: async (a: string, t: string, fn: () => Promise<unknown>) => {
    lockLog.push(`enter:${a}/${t}`);
    try { return await fn(); } finally { lockLog.push('exit'); }
  },
}));
vi.mock('../services/docker', () => ({
  getTenantInfo: vi.fn(async (appId: string, tenantId: string) => ({ appId, tenantId })),
  listTenants: vi.fn(async () => []),
}));

// Behaviour switches for the docker/restic mock
const behaviour = { lsError: null as null | string, cpError: null as null | string, restoreDir: '', loopData: false, noData: false };
const cpTimeouts: Array<number | undefined> = [];
const dockerCmds: string[][] = [];
let metadata: any = {};
let backedUpMetadata: any;

vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], opts: any, cb?: Function) => {
    const done = typeof opts === 'function' ? opts : cb!;
    const fail = (msg: string, stderr = '') => done(Object.assign(new Error(msg), { stderr }));
    (async () => {
      if (cmd === 'restic' && args[0] === 'restore') {
        const target = args[args.indexOf('--target') + 1];
        const dir = path.join(target, 'snap');
        await fs.mkdir(path.join(dir, 't1'), { recursive: true });
        await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify(metadata));
        await fs.writeFile(path.join(dir, 't1', 'database.sql'), '-- sql');
        if (behaviour.loopData) await fs.symlink('data', path.join(dir, 't1', 'data'));
        else if (!behaviour.noData) await fs.mkdir(path.join(dir, 't1', 'data'), { recursive: true });
        return done(null, { stdout: '', stderr: '' });
      }
      if (cmd === 'restic' && args[0] === 'backup') {
        backedUpMetadata = JSON.parse(await fs.readFile(path.join(args[1], 'metadata.json'), 'utf-8'));
        return done(null, { stdout: '{"message_type":"summary","snapshot_id":"abc"}', stderr: '' });
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
      if (cmd === 'docker') dockerCmds.push(args);
      if (cmd === 'docker' && args.includes('ls')) {
        if (behaviour.lsError) return fail('Command failed', behaviour.lsError);
        return done(null, { stdout: 'file.txt\n', stderr: '' });
      }
      if (cmd === 'docker' && args[0] === 'cp') {
        cpTimeouts.push(opts?.timeout);
        if (behaviour.cpError) return fail(behaviour.cpError);
        return done(null, { stdout: '', stderr: '' });
      }
      return done(null, { stdout: '', stderr: '' });
    })();
  },
  spawn: vi.fn(),
}));

import { createBackup, restoreBackup, restoreBackupLocked } from '../services/backup';

async function writeEnv(tenantId: string, content: string) {
  const dir = path.join(appsDir, 'gadgets', 'tenants', tenantId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '.env'), content);
}

describe('backup/restore integrity', () => {
  beforeEach(async () => {
    appsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bkint-'));
    vi.clearAllMocks();
    mockReadTenantAppDef.mockImplementation(async () => mockApp);
    lockLog.length = 0; dockerCmds.length = 0;
    behaviour.lsError = null; behaviour.cpError = null; behaviour.loopData = false; behaviour.noData = false; backedUpMetadata = undefined;
    metadata = { appId: 'gadgets', tenants: ['t1'] };
    process.env.RESTIC_PASSWORD = 'test';
    process.env.S3_ENDPOINT = 'https://s3';
    process.env.S3_BUCKET = 'bucket';
    process.env.S3_AK = 'ak';
    process.env.S3_SK = 'sk';
    await writeEnv('t1', 'DB_NAME=acme_proj_t1\n');
  });
  afterEach(async () => { await fs.rm(appsDir, { recursive: true, force: true }); });

  it('gives docker cp of data volumes the long timeout on backup and restore', async () => {
    cpTimeouts.length = 0;
    await createBackup('gadgets', 't1');
    await restoreBackup('gadgets', 'abcd1234', 't1');
    expect(cpTimeouts.length).toBeGreaterThanOrEqual(2);
    for (const t of cpTimeouts) expect(t).toBeGreaterThanOrEqual(3_600_000);
  });

  it('dumps the migrated tenant DB_NAME, not appId_tenantId', async () => {
    await createBackup('gadgets', 't1');
    expect(mockDump).toHaveBeenCalledWith('proj_t1', expect.any(String));
  });

  it('restores a migrated tenant into its DB_NAME', async () => {
    const r = await restoreBackup('gadgets', 'abcd1234', 't1');
    expect(r.success).toBe(true);
    expect(mockRestore).toHaveBeenCalledWith('proj_t1', expect.any(String));
  });

  it('records an exec ls failure (stopped container) as an incomplete path', async () => {
    behaviour.lsError = 'Error response from daemon: container x is not running';
    const r = await createBackup('gadgets', 't1');
    expect(r.success).toBe(true);
    const meta = backedUpMetadata;
    expect(meta.incomplete).toBe(true);
    expect(meta.missingPaths[0]).toMatchObject({ service: 'web', path: '/data' });
  });

  it('treats "No such file or directory" as an empty path, not incomplete', async () => {
    behaviour.lsError = "ls: /data: No such file or directory";
    await createBackup('gadgets', 't1');
    expect(backedUpMetadata.incomplete).toBeUndefined();
  });

  it('returns a warning when a path fails to restore but the DB restored', async () => {
    behaviour.cpError = 'container not running /tmp/acme-backups/restore-1 secret-stderr';
    const r = await restoreBackup('gadgets', 'abcd1234', 't1');
    expect(r.success).toBe(true);
    expect(r.warnings?.length).toBe(1);
    expect(r.warnings).toEqual(['/data: not restored (copy failed; see server logs)']);
    const text = JSON.stringify(r.warnings);
    expect(text).not.toMatch(/Command failed|\/tmp\/|secret-stderr|docker cp/);
  });

  it('warns (fixed text) when backup data cannot be read, but skips a missing path silently', async () => {
    behaviour.loopData = true;
    const r = await restoreBackup('gadgets', 'abcd1234', 't1');
    expect(r.success).toBe(true);
    expect(r.warnings).toEqual(['/data: not restored (backup data unreadable; see server logs)']);
  });

  it('does not warn when the path is absent from the backup', async () => {
    behaviour.noData = true;
    const r = await restoreBackup('gadgets', 'abcd1234', 't1');
    expect(r.warnings).toBeUndefined();
  });

  it('surfaces metadata.incomplete as a warning', async () => {
    metadata = { appId: 'gadgets', tenants: ['t1'], incomplete: true, missingPaths: [{ service: 'web', path: '/data', error: 'x' }] };
    const r = await restoreBackup('gadgets', 'abcd1234', 't1');
    expect(r.success).toBe(true);
    expect(r.warnings?.some(w => /incomplete/i.test(w))).toBe(true);
  });

  it('has no warnings on a clean restore', async () => {
    const r = await restoreBackup('gadgets', 'abcd1234', 't1');
    expect(r.warnings).toBeUndefined();
  });

  it('restores the paths of the tenant snapshot, not the global definition', async () => {
    const snapshot = { ...mockApp, services: [{ name: 'api', backup: { enabled: true, paths: [{ container: '/uploads', local: 'data' }] } }] };
    mockReadTenantAppDef.mockImplementation(async () => snapshot);
    await restoreBackup('gadgets', 'abcd1234', 't1');
    expect(mockReadTenantAppDef).toHaveBeenCalledWith('gadgets', 't1');
    const cp = dockerCmds.find(a => a[0] === 'cp')!;
    expect(cp[2]).toBe('gadgets-t1-api:/uploads/');
    expect(dockerCmds.some(a => a.join(' ').includes('gadgets-t1-web'))).toBe(false);
  });

  it('falls back to the global definition when no tenant snapshot exists', async () => {
    mockReadTenantAppDef.mockImplementation(async () => null);
    await restoreBackup('gadgets', 'abcd1234', 't1');
    expect(dockerCmds.find(a => a[0] === 'cp')![2]).toBe('gadgets-t1-web:/data/');
  });

  it('serialises on the tenant lock for the whole restore', async () => {
    mockRestore.mockImplementationOnce(async () => { lockLog.push('db-restore'); });
    await restoreBackup('gadgets', 'abcd1234', 't1');
    expect(lockLog).toEqual(['enter:gadgets/t1', 'db-restore', 'exit']);
  });

  it('restoreBackupLocked leaves locking to the caller', async () => {
    const r = await restoreBackupLocked('gadgets', 'abcd1234', 't1');
    expect(r.success).toBe(true);
    expect(lockLog).toEqual([]);
  });

  it('copies into stopped containers without exec mkdir when containersStopped is set', async () => {
    await restoreBackupLocked('gadgets', 'abcd1234', 't1', { containersStopped: true });
    expect(dockerCmds.some(a => a[0] === 'exec')).toBe(false);
    expect(dockerCmds.some(a => a[0] === 'cp')).toBe(true);
  });

  it('still creates the target directory in running containers', async () => {
    await restoreBackup('gadgets', 'abcd1234', 't1');
    expect(dockerCmds.some(a => a[0] === 'exec' && a.includes('mkdir'))).toBe(true);
  });

  it('reports an invalid tenant snapshot as a failed restore instead of rejecting', async () => {
    mockReadTenantAppDef.mockRejectedValue(new Error('app-definition.json failed validation'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await restoreBackup('gadgets', 'abcd1234', 't1');
    expect(r.success).toBe(false);
    expect(r.error).toBeTruthy();
    expect(mockRestore).not.toHaveBeenCalled();
  });
});
