import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import jwt from 'jsonwebtoken';

let tmpDir: string;
vi.mock('../config', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, getDataDir: () => tmpDir };
});
vi.mock('../services/users', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, getUserRole: vi.fn(async () => 'editor'), isAdminEmail: vi.fn(async () => true) };
});
const writeAuditEntry = vi.fn();
vi.mock('../services/auditLog', () => ({ writeAuditEntry: (e: unknown) => writeAuditEntry(e) }));

import authRouter from '../routes/auth';
import { authMiddleware } from '../middleware/auth';
import { signSession, verifySession, SESSION_AUDIENCE, SESSION_ISSUER } from '../auth/session';
import { revokeSession, isSessionRevoked } from '../auth/sessionRevocations';
import { createWebSocketServer, stopWebSocketServer } from '../websocket/server';

const STORE = () => path.join(tmpDir, 'revoked-sessions.json');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/auth', authRouter);
  a.get('/api/x', authMiddleware, (_req, res) => { res.json({ ok: true }); });
  return a;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-logout-'));
  process.env.JWT_SECRET = 'x'.repeat(40);
  writeAuditEntry.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('session revocation store', () => {
  it('records a revoked jti, written 0600, and prunes entries past their expiry', async () => {
    const now = Math.floor(Date.now() / 1000);
    await revokeSession('old', now - 10);
    await revokeSession('live', now + 3600);
    expect(await isSessionRevoked('live')).toBe(true);
    expect(await isSessionRevoked('other')).toBe(false);
    const stored = JSON.parse(await fs.readFile(STORE(), 'utf8'));
    expect(Object.keys(stored.revoked)).toEqual(['live']);
    expect((await fs.stat(STORE())).mode & 0o777).toBe(0o600);
  });

  it('keeps every revocation when several land at once', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    await Promise.all(Array.from({ length: 8 }, (_, i) => revokeSession(`j${i}`, exp)));
    for (let i = 0; i < 8; i++) expect(await isSessionRevoked(`j${i}`)).toBe(true);
  });

  it('a missing store revokes nothing', async () => {
    expect(await isSessionRevoked('anything')).toBe(false);
  });

  it('a corrupt store does not lock everyone out: it is reported and treated as empty', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await fs.writeFile(STORE(), '{not json');
    expect(await isSessionRevoked('x')).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('revoked-sessions.json'));
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the presented session; other sessions of the same user keep working', async () => {
    const token = signSession('a@b.c');
    const other = signSession('a@b.c');
    expect((await request(app()).get('/api/x').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    const out = await request(app()).post('/api/auth/logout').set('Authorization', `Bearer ${token}`);
    expect(out.status).toBe(200);
    expect((await request(app()).get('/api/x').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    expect((await request(app()).get('/api/auth/verify').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    expect((await request(app()).get('/api/x').set('Authorization', `Bearer ${other}`)).status).toBe(200);
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ user: 'a@b.c', action: 'logout', path: '/api/auth/logout', status: 200 }));
  });

  it('accepts a session from before jti existed; it stays valid until it expires', async () => {
    const legacy = jwt.sign({ email: 'a@b.c' }, process.env.JWT_SECRET!, { expiresIn: '1h', audience: SESSION_AUDIENCE, issuer: SESSION_ISSUER });
    expect((await request(app()).post('/api/auth/logout').set('Authorization', `Bearer ${legacy}`)).status).toBe(200);
    expect((await request(app()).get('/api/x').set('Authorization', `Bearer ${legacy}`)).status).toBe(200);
  });

  it('requires a session', async () => {
    expect((await request(app()).post('/api/auth/logout')).status).toBe(401);
  });
});

describe('WebSocket and revoked sessions', () => {
  let server: http.Server;
  let port: number;
  beforeEach(async () => {
    server = http.createServer();
    createWebSocketServer(server, { membershipRecheckMs: 50, membershipReadTimeoutMs: 100 });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    stopWebSocketServer();
    await new Promise<void>((r) => server.close(() => r()));
  });

  function connect(token: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: string[] = [];
    ws.on('message', (d) => messages.push(d.toString()));
    ws.on('error', () => {});
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    return { ws, messages, closed };
  }

  it('refuses a revoked session', async () => {
    const token = signSession('a@b.c');
    const s = verifySession(token);
    await revokeSession(s.jti!, s.exp);
    expect(await connect(token).closed).toBe(4003);
  });

  it('closes an open socket once its session is revoked', async () => {
    const token = signSession('a@b.c');
    const c = connect(token);
    await vi.waitFor(() => expect(c.messages.join()).toContain('auth:ok'));
    const s = verifySession(token);
    await revokeSession(s.jti!, s.exp);
    expect(await c.closed).toBe(4401);
  });
});
