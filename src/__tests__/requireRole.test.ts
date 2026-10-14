import { describe, it, expect, afterEach, vi } from 'vitest';

afterEach(() => { vi.resetModules(); });

describe('R6 requireRole middleware gates by the role authMiddleware resolved', () => {
  const setup = async (role: 'viewer' | 'editor' | 'admin' | undefined) => {
    const { requireRole } = await import('../middleware/requireRole');
    return { requireRole, user: { email: 'u@test.com', role: role ?? 'admin' } };
  };

  const mkRes = (user: unknown, onJson: (body: any, status: number) => void) => {
    const res: any = { statusCode: 200, body: undefined, locals: { user } };
    res.status = (s: number) => { res.statusCode = s; return res; };
    res.json = (b: any) => { res.body = b; onJson(b, res.statusCode); return res; };
    return res;
  };

  const invoke = (mw: any, user: unknown) => new Promise<{ nexted: boolean; status: number; body: any }>((resolve) => {
    let nexted = false;
    const res = mkRes(user, (body, status) => resolve({ nexted, status, body }));
    mw({ headers: {} } as any, res, () => { nexted = true; resolve({ nexted, status: res.statusCode, body: undefined }); });
  });

  it('403s a viewer trying to perform admin action', async () => {
    const { requireRole, user } = await setup('viewer');
    const r = await invoke(requireRole('admin'), user);
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/admin/);
  });

  it('allows admin through an admin-gated route', async () => {
    const { requireRole, user } = await setup('admin');
    const r = await invoke(requireRole('admin'), user);
    expect(r.nexted).toBe(true);
  });

  it('401s when authMiddleware did not run (no res.locals.user)', async () => {
    const { requireRole } = await setup('admin');
    const r = await invoke(requireRole('viewer'), undefined);
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(401);
  });
});


