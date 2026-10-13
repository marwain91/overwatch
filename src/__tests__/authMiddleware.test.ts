import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const getUserRole = vi.fn();
vi.mock('../services/users', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, getUserRole: (...a: unknown[]) => getUserRole(...a) };
});
const writeAuditEntry = vi.fn();
vi.mock('../services/auditLog', () => ({ writeAuditEntry: (e: unknown) => writeAuditEntry(e) }));

import { authMiddleware } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { auditLog } from '../middleware/audit';
import { signSession } from '../auth/session';
import { getCurrentUserEmail } from '../utils/jwt';

function appWith(...mw: express.RequestHandler[]) {
  const app = express();
  app.use(express.json());
  app.use('/api/x', authMiddleware, ...mw, (req, res) => {
    res.json({ ok: true, user: res.locals.user, helper: getCurrentUserEmail(req) });
  });
  return app;
}

beforeEach(() => {
  process.env.JWT_SECRET = 'x'.repeat(40);
  getUserRole.mockReset();
  writeAuditEntry.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('authMiddleware', () => {
  it('resolves the role once per request and exposes it on res.locals.user', async () => {
    getUserRole.mockResolvedValue('editor');
    const res = await request(appWith(requireRole('viewer'), requireRole('editor'), auditLog))
      .post('/api/x').set('Authorization', `Bearer ${signSession('a@b.c')}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ email: 'a@b.c', role: 'editor' });
    expect(res.body.helper).toBe('a@b.c');
    expect(getUserRole).toHaveBeenCalledTimes(1);
  });

  it('requireRole enforces the resolved role', async () => {
    getUserRole.mockResolvedValue('viewer');
    const res = await request(appWith(requireRole('admin')))
      .post('/api/x').set('Authorization', `Bearer ${signSession('a@b.c')}`).send({});
    expect(res.status).toBe(403);
  });

  it('audit entries carry the user from res.locals', async () => {
    getUserRole.mockResolvedValue('admin');
    await request(appWith(auditLog)).post('/api/x').set('Authorization', `Bearer ${signSession('a@b.c')}`).send({});
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ user: 'a@b.c' }));
  });

  it('401s (fail closed) a valid token whose user is no longer an admin', async () => {
    getUserRole.mockResolvedValue(undefined);
    const res = await request(appWith()).post('/api/x').set('Authorization', `Bearer ${signSession('gone@b.c')}`).send({});
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('401s a token without the web audience and never reads admin-users', async () => {
    const legacy = jwt.sign({ email: 'a@b.c' }, process.env.JWT_SECRET!, { expiresIn: '1h' });
    const res = await request(appWith()).post('/api/x').set('Authorization', `Bearer ${legacy}`).send({});
    expect(res.status).toBe(401);
    expect(getUserRole).not.toHaveBeenCalled();
  });

  it('401s a missing Authorization header', async () => {
    const res = await request(appWith()).post('/api/x').send({});
    expect(res.status).toBe(401);
  });

  it('500s when the admin-users lookup fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getUserRole.mockRejectedValue(new Error('disk'));
    const res = await request(appWith()).post('/api/x').set('Authorization', `Bearer ${signSession('a@b.c')}`).send({});
    expect(res.status).toBe(500);
  });
});
