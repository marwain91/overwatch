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

// Like the adapters, the dump writes its file (a restore checks the safety dump).
const mockDump = vi.fn(async (_id: string, out: string) => { await fs.writeFile(out, '-- dump'); });
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
    resetDatabase: vi.fn().mockResolvedValue(undefined),
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
const behaviour = { copyOutError: null as null | string, cpError: null as null | string, restoreDir: '', loopData: false, noData: false };
const cpTimeouts: Array<number | undefined> = [];
const dockerCmds: string[][] = [];
let metadata: any = {};
let backedUpMetadata: any;

vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], opts: any, cb?: Function) => {
    const done = typeof opts === 'function' ? opts : cb!;
    const fail = (msg: string, stderr = '') => done(Object.assign(new Error(msg), { stderr }));
    (async () => {
      if (cmd === 'restic' && args[0] === 'snapshots' && args.length === 3) {
        // restore checks the snapshot belongs to the app and the tenant
        return done(null, { stdout: JSON.stringify([{ id: args[2], short_id: args[2].slice(0, 8), tags: ['app:gadgets', 'tenant:t1'] }]), stderr: '' });
      }
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
      if (cmd === 'docker' && args[0] === 'cp' && args[1].includes(':') && behaviour.copyOutError) {
        return fail('Command failed', behaviour.copyOutError);
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
    behaviour.copyOutError = null; behaviour.cpError = null; behaviour.loopData = false; behaviour.noData = false; backedUpMetadata = undefined;
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
    expect(mockRestore).toHaveBeenCalledWith('proj_t1', expect.any(String), expect.any(Object));
  });

  it('records a path that could not be copied (container removed) as an incomplete path', async () => {
    behaviour.copyOutError = 'Error response from daemon: No such container: gadgets-t1-web';
    const r = await createBackup('gadgets', 't1');
    expect(r.success).toBe(true);
    const meta = backedUpMetadata;
    expect(meta.incomplete).toBe(true);
    expect(meta.missingPaths[0]).toMatchObject({ service: 'web', path: '/data' });
  });

  it('treats a path missing in the container as empty, not incomplete', async () => {
    behaviour.copyOutError = 'Error response from daemon: Could not find the file /data/. in container gadgets-t1-web';
    await createBackup('gadgets', 't1');
    expect(backedUpMetadata.incomplete).toBeUndefined();
  });

  // exec needs a running container; docker cp also reads a stopped one.
  it('copies data out without exec, so a stopped tenant is backed up completely', async () => {
    const r = await createBackup('gadgets', 't1');
    expect(r.incomplete).toBeUndefined();
    expect(dockerCmds.some(a => a[0] === 'exec')).toBe(false);
    expect(dockerCmds.find(a => a[0] === 'cp')).toEqual(['cp', 'gadgets-t1-web:/data/.', expect.stringMatching(/\/t1\/data\/$/)]);
  });

  // In place a failed copy rolls the tenant back (restoreSafety.test.ts); a
  // new tenant from a backup keeps it as a warning.
  it('returns a warning when a path fails to restore but the DB restored', async () => {
    behaviour.cpError = 'container not running /tmp/acme-backups/restore-1 secret-stderr';
    const r = await restoreBackupLocked('gadgets', 'abcd1234', 't1', { createNew: true, newDomain: 't1.example.com', containersStopped: true });
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
    const cp = dockerCmds.find(a => a[0] === 'cp' && a[2].includes(':'))!;
    expect(cp[2]).toBe('gadgets-t1-api:/uploads/');
    expect(dockerCmds.some(a => a.join(' ').includes('gadgets-t1-web'))).toBe(false);
  });

  it('falls back to the global definition when no tenant snapshot exists', async () => {
    mockReadTenantAppDef.mockImplementation(async () => null);
    await restoreBackup('gadgets', 'abcd1234', 't1');
    expect(dockerCmds.find(a => a[0] === 'cp' && a[2].includes(':'))![2]).toBe('gadgets-t1-web:/data/');
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
    await restoreBackupLocked('gadgets', 'abcd1234', 't1', { createNew: true, newDomain: 't1.example.com', containersStopped: true });
    expect(dockerCmds.some(a => a[0] === 'exec')).toBe(false);
    expect(dockerCmds.some(a => a[0] === 'cp')).toBe(true);
  });

  it('still creates the target directory in running containers', async () => {
    await restoreBackupLocked('gadgets', 'abcd1234', 't1', { createNew: true, newDomain: 't1.example.com' });
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
