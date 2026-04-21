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

describe('R4 runDocker — error classification (unit, no subprocess)', () => {
  // Avoid actually spawning `docker` — CI runners (alpine node image) don't have
  // the docker CLI and hit vitest's timeout before ENOENT propagates.
  it('SIGTERM / SIGKILL → timeout', async () => {
    const { classifyError } = await import('../utils/runDocker');
    expect(classifyError('', null, 'SIGTERM')).toBe('timeout');
    expect(classifyError('', null, 'SIGKILL')).toBe('timeout');
  });

  it('"Cannot connect to the Docker daemon" → daemon_unreachable', async () => {
    const { classifyError } = await import('../utils/runDocker');
    expect(classifyError('Cannot connect to the Docker daemon at unix:///var/run/docker.sock.', 1, null))
      .toBe('daemon_unreachable');
  });

  it('"No such container" → unknown_container', async () => {
    const { classifyError } = await import('../utils/runDocker');
    expect(classifyError('Error: No such container: kwoutr-daktela-web', 1, null))
      .toBe('unknown_container');
  });

  it('exit 126 / "permission denied" → permission', async () => {
    const { classifyError } = await import('../utils/runDocker');
    expect(classifyError('', 126, null)).toBe('permission');
    expect(classifyError('permission denied while trying to connect', 1, null)).toBe('permission');
  });

  it('exit 127 / "not found" → cli_missing', async () => {
    const { classifyError } = await import('../utils/runDocker');
    expect(classifyError('', 127, null)).toBe('cli_missing');
    expect(classifyError('sh: docker: not found', 127, null)).toBe('cli_missing');
  });

  it('anything else → unknown', async () => {
    const { classifyError } = await import('../utils/runDocker');
    expect(classifyError('some generic failure', 1, null)).toBe('unknown');
  });
});
