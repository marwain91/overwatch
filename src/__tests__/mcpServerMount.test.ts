import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

let tmpDir: string;
vi.mock('../config', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, getDataDir: () => tmpDir };
});

vi.mock('../services/users', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, listAdminUsers: vi.fn(async () => [{ email: 'a@b.c', role: 'editor', addedAt: 'x', addedBy: 'x' }]) };
});

import { mountMcp } from '../mcp/server';
import { issueAccessToken } from '../oauth/tokens';

const ISSUER = 'https://ow.example.com';

describe('mountMcp', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-mcpmount-'));
    process.env.JWT_SECRET = 'x'.repeat(40);
    process.env.GOOGLE_CLIENT_ID = 'cid';
  });

  it('serves protected-resource metadata without auth', async () => {
    const app = express();
    app.use(express.json());
    mountMcp(app, { issuer: ISSUER, accessTokenTtl: '1h', refreshTokenTtl: '30d' });
    const res = await request(app).get('/.well-known/oauth-protected-resource');
    expect(res.status).toBe(200);
    expect(res.body.resource).toBe('https://ow.example.com/mcp');
  });

  it('rejects an unauthenticated /mcp request with 401 + WWW-Authenticate', async () => {
    const app = express();
    app.use(express.json());
    mountMcp(app, { issuer: ISSUER, accessTokenTtl: '1h', refreshTokenTtl: '30d' });
    const res = await request(app).post('/mcp').send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/Bearer/);
  });

  it.each([
    ['an expired token', () => issueAccessToken({ email: 'a@b.c', role: 'editor', issuer: ISSUER, ttl: '-1s' })],
    ['a malformed token', () => 'not-a-jwt'],
    ['a token for a removed admin', () => issueAccessToken({ email: 'gone@b.c', role: 'editor', issuer: ISSUER, ttl: '1h' })],
  ])('answers %s with 401 + WWW-Authenticate so the client refreshes', async (_label, make) => {
    const app = express();
    app.use(express.json());
    mountMcp(app, { issuer: ISSUER, accessTokenTtl: '1h', refreshTokenTtl: '30d' });
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${make()}`)
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/invalid_token/);
  });

  it('accepts a valid bearer token through requireBearerAuth (regression: expiresAt)', async () => {
    const app = express();
    app.use(express.json());
    mountMcp(app, { issuer: ISSUER, accessTokenTtl: '1h', refreshTokenTtl: '30d' });
    const token = issueAccessToken({ email: 'a@b.c', role: 'editor', issuer: ISSUER, ttl: '1h' });
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    expect(res.status).not.toBe(401);
    expect(JSON.stringify(res.body) + res.text).not.toMatch(/expiration/i);
  });

  it('limits dynamic client registration per IP more strictly than the other OAuth endpoints', async () => {
    const app = express();
    app.use(express.json());
    mountMcp(app, { issuer: ISSUER, accessTokenTtl: '1h', refreshTokenTtl: '30d' });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await request(app).post('/oauth/register').send({ client_name: `c${i}`, redirect_uris: ['https://client/cb'] })).status);
    }
    expect(statuses.slice(0, 10).every(s => s === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
    // Other OAuth endpoints keep their own, larger budget.
    expect((await request(app).post('/oauth/revoke').type('form').send({ token: 'x' })).status).toBe(200);
  });
});
