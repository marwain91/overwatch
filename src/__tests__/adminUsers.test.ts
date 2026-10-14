import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let tmpRoot: string;
let usersFile: string;

async function seed(users: unknown[]) {
  await fs.writeFile(usersFile, JSON.stringify(users));
}
const rec = (email: string, role?: string) => ({ email, addedAt: '2026-01-01T00:00:00.000Z', addedBy: 'system', ...(role ? { role } : {}) });

beforeEach(async () => {
  vi.resetModules();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-admin-users-'));
  usersFile = path.join(tmpRoot, 'admin-users.json');
  vi.doMock('../config', () => ({ getDataDir: () => tmpRoot }));
  vi.doMock('../services/fileLock', () => ({ withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn() }));
});

afterEach(async () => {
  vi.doUnmock('../config');
  vi.doUnmock('../services/fileLock');
  vi.doUnmock('../middleware/requireRole');
    await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('services/users roles', () => {
  it('addAdminUser defaults the stored role to viewer', async () => {
    await seed([rec('root@example.com')]);
    const { addAdminUser, getUserRole } = await import('../services/users');
    const u = await addAdminUser('New@Example.com', 'root@example.com');
    expect(u.role).toBe('viewer');
    expect(await getUserRole('new@example.com')).toBe('viewer');
    const onDisk = JSON.parse(await fs.readFile(usersFile, 'utf-8'));
    expect(onDisk.find((x: any) => x.email === 'new@example.com').role).toBe('viewer');
  });

  it('addAdminUser stores an explicit role', async () => {
    await seed([rec('root@example.com')]);
    const { addAdminUser } = await import('../services/users');
    expect((await addAdminUser('e@example.com', 'root@example.com', 'editor')).role).toBe('editor');
  });

  it('a legacy record without a role stays admin', async () => {
    await seed([rec('legacy@example.com')]);
    const { getUserRole, listAdminUsers } = await import('../services/users');
    expect(await getUserRole('legacy@example.com')).toBe('admin');
    expect((await listAdminUsers())[0].role).toBeUndefined();
  });

  it('setAdminUserRole changes the role and is case-insensitive', async () => {
    await seed([rec('a@example.com', 'admin'), rec('b@example.com', 'viewer')]);
    const { setAdminUserRole, getUserRole } = await import('../services/users');
    const updated = await setAdminUserRole('B@Example.com', 'editor', 'a@example.com');
    expect(updated.role).toBe('editor');
    expect(await getUserRole('b@example.com')).toBe('editor');
  });

  it('setAdminUserRole on an unknown user is a NotFoundError', async () => {
    await seed([rec('a@example.com', 'admin')]);
    const { setAdminUserRole } = await import('../services/users');
    const { NotFoundError } = await import('../utils/httpErrors');
    await expect(setAdminUserRole('ghost@example.com', 'viewer', 'a@example.com')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses to demote the last admin, counting legacy records as admin', async () => {
    await seed([rec('legacy@example.com'), rec('v@example.com', 'viewer')]);
    const { setAdminUserRole, getUserRole } = await import('../services/users');
    const { ConflictError } = await import('../utils/httpErrors');
    await expect(setAdminUserRole('legacy@example.com', 'viewer', 'legacy@example.com')).rejects.toBeInstanceOf(ConflictError);
    expect(await getUserRole('legacy@example.com')).toBe('admin');
  });

  it('allows demoting an admin when another admin remains', async () => {
    await seed([rec('legacy@example.com'), rec('b@example.com', 'admin')]);
    const { setAdminUserRole, getUserRole } = await import('../services/users');
    await setAdminUserRole('b@example.com', 'viewer', 'legacy@example.com');
    expect(await getUserRole('b@example.com')).toBe('viewer');
  });

  it('refuses to remove the last admin even when viewers remain', async () => {
    await seed([rec('root@example.com', 'admin'), rec('v@example.com', 'viewer')]);
    const { removeAdminUser } = await import('../services/users');
    const { ConflictError } = await import('../utils/httpErrors');
    await expect(removeAdminUser('root@example.com', 'cli')).rejects.toBeInstanceOf(ConflictError);
  });

  it('allows removing a viewer while a single admin remains', async () => {
    await seed([rec('root@example.com', 'admin'), rec('v@example.com', 'viewer')]);
    const { removeAdminUser, listAdminUsers } = await import('../services/users');
    await removeAdminUser('v@example.com', 'root@example.com');
    expect((await listAdminUsers()).map(u => u.email)).toEqual(['root@example.com']);
  });
});

describe('routes/adminUsers roles', () => {
  async function makeApp() {
    // Stands in for authMiddleware: caller identity is root@example.com with its seeded role.
    const { getUserRole } = await import('../services/users');
    const express = (await import('express')).default;
    const router = (await import('../routes/adminUsers')).default;
    const { errorHandler } = await import('../middleware/errorHandler');
    const app = express();
    app.use(express.json());
    app.use(async (_req, res, next) => {
      res.locals.user = { email: 'root@example.com', role: await getUserRole('root@example.com') };
      next();
    });
    app.use('/api/admin-users', router);
    app.use(errorHandler);
    return app;
  }

  it('POST defaults to viewer and accepts an explicit role', async () => {
    await seed([rec('root@example.com', 'admin')]);
    const request = (await import('supertest')).default;
    const app = await makeApp();
    const a = await request(app).post('/api/admin-users').send({ email: 'a@example.com' }).expect(201);
    expect(a.body.role).toBe('viewer');
    const b = await request(app).post('/api/admin-users').send({ email: 'b@example.com', role: 'editor' }).expect(201);
    expect(b.body.role).toBe('editor');
  });

  it('POST rejects an invalid role', async () => {
    await seed([rec('root@example.com', 'admin')]);
    const request = (await import('supertest')).default;
    const app = await makeApp();
    await request(app).post('/api/admin-users').send({ email: 'a@example.com', role: 'owner' }).expect(400);
    await request(app).post('/api/admin-users').send({ email: 'a@example.com', role: 5 }).expect(400);
  });

  it('PATCH changes a role, validates input and maps errors', async () => {
    await seed([rec('root@example.com', 'admin'), rec('v@example.com', 'viewer')]);
    const request = (await import('supertest')).default;
    const app = await makeApp();
    const ok = await request(app).patch('/api/admin-users/v%40example.com').send({ role: 'editor' }).expect(200);
    expect(ok.body.role).toBe('editor');
    await request(app).patch('/api/admin-users/v%40example.com').send({ role: 'root' }).expect(400);
    await request(app).patch('/api/admin-users/v%40example.com').send({}).expect(400);
    await request(app).patch('/api/admin-users/not-an-email').send({ role: 'viewer' }).expect(400);
    await request(app).patch('/api/admin-users/ghost%40example.com').send({ role: 'viewer' }).expect(404);
    // demoting the only admin is a conflict
    await request(app).patch('/api/admin-users/root%40example.com').send({ role: 'viewer' }).expect(409);
  });

  it('PATCH and POST are 403 for non-admin callers', async () => {
    await seed([rec('root@example.com', 'editor'), rec('v@example.com', 'viewer')]);
    const request = (await import('supertest')).default;
    const app = await makeApp();
    await request(app).patch('/api/admin-users/v%40example.com').send({ role: 'admin' }).expect(403);
    await request(app).post('/api/admin-users').send({ email: 'x@example.com' }).expect(403);
  });

  it('GET returns the effective role, legacy records as admin', async () => {
    await seed([rec('root@example.com'), rec('v@example.com', 'viewer')]);
    const request = (await import('supertest')).default;
    const app = await makeApp();
    const res = await request(app).get('/api/admin-users').expect(200);
    expect(res.body.map((u: any) => [u.email, u.role])).toEqual([['root@example.com', 'admin'], ['v@example.com', 'viewer']]);
  });
});
