import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const getUserRole = vi.fn();
vi.mock('../services/users', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, getUserRole: (...a: unknown[]) => getUserRole(...a) };
});

const verifySessionSpy = vi.fn();
vi.mock('../auth/session', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, verifySession: (...a: unknown[]) => { verifySessionSpy(...a); return actual.verifySession(...a); } };
});

import authRouter from '../routes/auth';
import { signSession } from '../auth/session';

function app() {
  const a = express();
  a.use('/api/auth', authRouter);
  return a;
}

beforeEach(() => {
  process.env.JWT_SECRET = 'x'.repeat(40);
  getUserRole.mockReset();
  verifySessionSpy.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('GET /api/auth/verify', () => {
  it('returns the current role of the caller', async () => {
    getUserRole.mockResolvedValue('viewer');
    const res = await request(app()).get('/api/auth/verify')
      .set('Authorization', `Bearer ${signSession('a@b.c', { name: 'A', picture: 'p' })}`);
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ email: 'a@b.c', name: 'A', picture: 'p', role: 'viewer' });
  });

  it('verifies the session token once per request', async () => {
    getUserRole.mockResolvedValue('editor');
    await request(app()).get('/api/auth/verify')
      .set('Authorization', `Bearer ${signSession('a@b.c', { name: 'A', picture: 'p' })}`)
      .expect(200);
    expect(verifySessionSpy).toHaveBeenCalledTimes(1);
  });

  it('401s a valid token whose admin user was removed', async () => {
    getUserRole.mockResolvedValue(undefined);
    const res = await request(app()).get('/api/auth/verify')
      .set('Authorization', `Bearer ${signSession('gone@b.c')}`);
    expect(res.status).toBe(401);
  });

  it('401s without a token', async () => {
    const res = await request(app()).get('/api/auth/verify');
    expect(res.status).toBe(401);
  });
});
