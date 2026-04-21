import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { can, normaliseRole } from '../services/users';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-sprint4-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
});

describe('R6 RBAC role hierarchy', () => {
  it('admin can do everything', () => {
    expect(can('admin', 'viewer')).toBe(true);
    expect(can('admin', 'editor')).toBe(true);
    expect(can('admin', 'admin')).toBe(true);
  });

  it('editor can edit but not admin', () => {
    expect(can('editor', 'viewer')).toBe(true);
    expect(can('editor', 'editor')).toBe(true);
    expect(can('editor', 'admin')).toBe(false);
  });

  it('viewer can only view', () => {
    expect(can('viewer', 'viewer')).toBe(true);
    expect(can('viewer', 'editor')).toBe(false);
    expect(can('viewer', 'admin')).toBe(false);
  });

  it('missing role defaults to admin (backward compat with pre-RBAC installs)', () => {
    expect(normaliseRole(undefined)).toBe('admin');
    expect(can(undefined, 'admin')).toBe(true);
  });
});

describe('R6 requireRole middleware gates by JWT email + admin-users role', () => {
  const setup = async (role: 'viewer' | 'editor' | 'admin' | undefined) => {
    const dataDir = path.join(tmpRoot, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    const user: any = {
      email: 'u@test.com', addedAt: new Date().toISOString(), addedBy: 'seed',
    };
    if (role) user.role = role;
    await fs.writeFile(path.join(dataDir, 'admin-users.json'), JSON.stringify([user]));
    vi.doMock('../config', () => ({ getDataDir: () => dataDir }));
    vi.doMock('../utils/jwt', () => ({ getCurrentUserEmail: () => 'u@test.com' }));
    vi.doMock('./fileLock', () => ({ withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn() }));
    const { requireRole } = await import('../middleware/requireRole');
    return requireRole;
  };

  const mkReq = (headers: Record<string, string> = {}) => ({ headers, header: (n: string) => headers[n] }) as any;
  const mkRes = (onJson: (body: any, status: number) => void) => {
    const res: any = { statusCode: 200, body: undefined };
    res.status = (s: number) => { res.statusCode = s; return res; };
    res.json = (b: any) => { res.body = b; onJson(b, res.statusCode); return res; };
    return res;
  };

  const invoke = (mw: any) => new Promise<{ nexted: boolean; status: number; body: any }>((resolve) => {
    let nexted = false;
    const res = mkRes((body, status) => resolve({ nexted, status, body }));
    mw(mkReq({ authorization: 'Bearer t' }), res, () => { nexted = true; resolve({ nexted, status: res.statusCode, body: undefined }); });
  });

  it('403s a viewer trying to perform admin action', async () => {
    const requireRole = await setup('viewer');
    const r = await invoke(requireRole('admin'));
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/admin/);
  });

  it('allows admin through an admin-gated route', async () => {
    const requireRole = await setup('admin');
    const r = await invoke(requireRole('admin'));
    expect(r.nexted).toBe(true);
  });

  it('treats missing role as admin (backward compat)', async () => {
    const requireRole = await setup(undefined);
    const r = await invoke(requireRole('admin'));
    expect(r.nexted).toBe(true);
  });
});

describe('R4 runDocker — timeout + structured errors', () => {
  it('returns a structured error with kind + stderr when docker call fails', async () => {
    const { runDocker } = await import('../utils/runDocker');
    let caught: any = null;
    try {
      await runDocker('docker' as any, ['--definitely-not-a-flag-that-exists-anywhere-zzz'], { timeoutMs: 5_000 });
    } catch (err: any) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    // We assert structural shape rather than prototype: the error carries the
    // fields runDocker promises. (vi.resetModules() in afterEach can re-import
    // the module and break instanceof across files.)
    expect(typeof caught.kind).toBe('string');
    expect(['cli_missing', 'unknown', 'daemon_unreachable', 'permission']).toContain(caught.kind);
    expect(typeof caught.stderr).toBe('string');
    expect(caught.command).toBe('docker');
    expect(Array.isArray(caught.args)).toBe(true);
  });
});
