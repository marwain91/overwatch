import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let root: string;
let appsDir: string;
let dataDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-regen-'));
  appsDir = path.join(root, 'apps');
  dataDir = path.join(root, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  vi.doMock('../config', () => ({ getAppsDir: () => appsDir, getDataDir: () => dataDir }));
});

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock('../config');
  vi.doUnmock('fs/promises');
  await fs.rm(root, { recursive: true, force: true });
});

async function tenant(app: string, id: string, withEnv = true) {
  const p = path.join(appsDir, app, 'tenants', id);
  await fs.mkdir(p, { recursive: true });
  if (withEnv) await fs.writeFile(path.join(p, '.env'), 'TENANT_DOMAIN=x\n');
  return p;
}

describe('regenerateAllSharedEnvFiles', () => {
  it('skips directories without .env and apps without a tenants dir', async () => {
    await tenant('demo', 'a');
    await tenant('demo', 'not-a-tenant', false);
    await fs.mkdir(path.join(appsDir, 'empty'), { recursive: true });
    const { regenerateAllSharedEnvFiles } = await import('../services/envVars');
    expect(await regenerateAllSharedEnvFiles()).toBe(1);
    await expect(fs.access(path.join(appsDir, 'demo', 'tenants', 'a', 'shared.env'))).resolves.toBeUndefined();
  });

  it('throws after the loop naming the failing tenants, without paths, and still regenerates the others', async () => {
    await tenant('demo', 'ok-one');
    const bad = await tenant('demo', 'bad-one');
    await fs.mkdir(path.join(bad, 'shared.env')); // write target is a directory
    await tenant('demo', 'ok-two');
    const { regenerateAllSharedEnvFiles, SharedEnvRegenerationError } = await import('../services/envVars');

    const err: any = await regenerateAllSharedEnvFiles('demo').catch(e => e);

    expect(err).toBeInstanceOf(SharedEnvRegenerationError);
    expect(err.status).toBe(500);
    expect(err.expose).toBe(true);
    expect(err.failures.map((f: any) => `${f.appId}/${f.tenantId}`)).toEqual(['demo/bad-one']);
    expect(err.clientMessage).toContain('demo/bad-one');
    expect(err.clientMessage).not.toContain(root);
    for (const id of ['ok-one', 'ok-two']) {
      await expect(fs.access(path.join(appsDir, 'demo', 'tenants', id, 'shared.env'))).resolves.toBeUndefined();
    }
  });

  it('collects a tenants-dir read failure for one app and still sweeps the others', async () => {
    await tenant('good', 'a');
    await tenant('broken', 'b');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    vi.doMock('fs/promises', () => ({
      ...actual,
      readdir: (p: any, ...rest: any[]) =>
        String(p) === path.join(appsDir, 'broken', 'tenants')
          ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
          : (actual.readdir as any)(p, ...rest),
    }));
    const { regenerateAllSharedEnvFiles } = await import('../services/envVars');

    const err: any = await regenerateAllSharedEnvFiles().catch(e => e);

    expect(err.failures.map((f: any) => f.appId)).toEqual(['broken']);
    await expect(fs.access(path.join(appsDir, 'good', 'tenants', 'a', 'shared.env'))).resolves.toBeUndefined();
  });

  it('treats a non-ENOENT failure reading a tenant .env as a failure, not "not a tenant", and still sweeps the rest', async () => {
    await tenant('demo', 'ok');
    const locked = await tenant('demo', 'locked');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    vi.doMock('fs/promises', () => ({
      ...actual,
      access: (p: any, ...rest: any[]) =>
        String(p) === path.join(locked, '.env')
          ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
          : (actual.access as any)(p, ...rest),
    }));
    const { regenerateAllSharedEnvFiles, SharedEnvRegenerationError } = await import('../services/envVars');

    const err: any = await regenerateAllSharedEnvFiles('demo').catch(e => e);

    expect(err).toBeInstanceOf(SharedEnvRegenerationError);
    expect(err.failures.map((f: any) => `${f.appId}/${f.tenantId}`)).toEqual(['demo/locked']);
    await expect(actual.access(path.join(appsDir, 'demo', 'tenants', 'ok', 'shared.env'))).resolves.toBeUndefined();
    await expect(actual.access(path.join(locked, 'shared.env'))).rejects.toThrow();
  });
});

describe('shared.env regeneration vs the tenant lock', () => {
  async function holdLock() {
    const { withTenantLock } = await import('../services/fileLock');
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let acquired!: () => void;
    const held = new Promise<void>(r => { acquired = r; });
    const holder = withTenantLock('demo', 'a', async () => { acquired(); await gate; });
    await held;
    return { release, holder };
  }
  const sharedEnv = () => path.join(appsDir, 'demo', 'tenants', 'a', 'shared.env');
  const exists = (p: string) => fs.access(p).then(() => true, () => false);

  it('regenerateAllSharedEnvFiles waits for a lifecycle operation holding the tenant lock', async () => {
    await tenant('demo', 'a');
    const { regenerateAllSharedEnvFiles } = await import('../services/envVars');
    const { release, holder } = await holdLock();
    const sweep = regenerateAllSharedEnvFiles('demo');
    await new Promise(r => setTimeout(r, 80));
    expect(await exists(sharedEnv())).toBe(false);
    release();
    await holder;
    expect(await sweep).toBe(1);
    expect(await exists(sharedEnv())).toBe(true);
  });

  it('generateSharedEnvFile waits for the tenant lock, but not when the caller already holds it', async () => {
    await tenant('demo', 'a');
    const { generateSharedEnvFile } = await import('../services/envVars');
    const { withTenantLock } = await import('../services/fileLock');
    const { release, holder } = await holdLock();
    const waiting = generateSharedEnvFile('demo', 'a');
    await new Promise(r => setTimeout(r, 80));
    expect(await exists(sharedEnv())).toBe(false);
    release();
    await holder;
    await waiting;
    expect(await exists(sharedEnv())).toBe(true);

    await fs.rm(sharedEnv());
    await withTenantLock('demo', 'a', () => generateSharedEnvFile('demo', 'a', { alreadyLocked: true }));
    expect(await exists(sharedEnv())).toBe(true);
  });
});
