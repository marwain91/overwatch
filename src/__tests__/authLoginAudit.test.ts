import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// routes/auth.ts reads GOOGLE_CLIENT_ID at import time.
vi.hoisted(() => { process.env.GOOGLE_CLIENT_ID = 'cid'; });

const resolveGoogleAdmin = vi.fn();
vi.mock('../services/identity', () => ({ resolveGoogleAdmin: (c: string) => resolveGoogleAdmin(c) }));
vi.mock('../services/users', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, getUserRole: vi.fn(async () => 'editor') };
});
const writeAuditEntry = vi.fn();
vi.mock('../services/auditLog', () => ({ writeAuditEntry: (e: unknown) => writeAuditEntry(e) }));

import authRouter from '../routes/auth';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/auth', authRouter);
  return a;
}

beforeEach(() => {
  process.env.JWT_SECRET = 'x'.repeat(40);
  resolveGoogleAdmin.mockReset();
  writeAuditEntry.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('web login audit', () => {
  it('audits a successful sign-in without the credential', async () => {
    resolveGoogleAdmin.mockResolvedValue({ ok: true, email: 'a@b.c', name: 'A' });
    const res = await request(app()).post('/api/auth/google').send({ credential: 'google-jwt' });
    expect(res.status).toBe(200);
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
      user: 'a@b.c', action: 'login', method: 'POST', path: '/api/auth/google', status: 200,
    }));
    expect(JSON.stringify(writeAuditEntry.mock.calls)).not.toContain('google-jwt');
  });

  it('audits a refused sign-in by a Google account that is not an admin', async () => {
    resolveGoogleAdmin.mockResolvedValue({ ok: false, reason: 'not_admin', email: 'intruder@b.c' });
    const res = await request(app()).post('/api/auth/google').send({ credential: 'google-jwt' });
    expect(res.status).toBe(403);
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ user: 'intruder@b.c', action: 'login denied', status: 403 }));
  });
});
