import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import express from 'express';
import request from 'supertest';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let tmpRoot: string;

beforeEach(async () => {
  vi.resetModules();
  process.env.JWT_SECRET = 'x'.repeat(40);
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-legacy-role-'));
  vi.doMock('../config', () => ({ getDataDir: () => tmpRoot }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.doUnmock('../config');
  vi.restoreAllMocks();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// Stored before RBAC existed: no `role` field. Real authMiddleware + requireRole,
// only the data dir is redirected.
async function appWithLegacyAdmin() {
  await fs.writeFile(path.join(tmpRoot, 'admin-users.json'), JSON.stringify([
    { email: 'legacy@example.com', addedAt: '2026-01-01T00:00:00.000Z', addedBy: 'system' },
  ]));
  const { authMiddleware } = await import('../middleware/auth');
  const { requireRole } = await import('../middleware/requireRole');
  const { signSession } = await import('../auth/session');
  const app = express();
  app.get('/api/admin-only', authMiddleware, requireRole('admin'), (_req, res) => {
    res.json({ ok: true, user: res.locals.user });
  });
  return { app, token: signSession('legacy@example.com') };
}

describe('legacy admin user without a stored role', () => {
  it('resolves to admin through authMiddleware and passes requireRole(admin)', async () => {
    const { app, token } = await appWithLegacyAdmin();
    const res = await request(app).get('/api/admin-only').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ email: 'legacy@example.com', role: 'admin' });
  });

  it('a user that is not in the store is still rejected (no fail-open)', async () => {
    const { app } = await appWithLegacyAdmin();
    const { signSession } = await import('../auth/session');
    const res = await request(app).get('/api/admin-only').set('Authorization', `Bearer ${signSession('stranger@example.com')}`);
    expect(res.status).toBe(401);
  });
});
