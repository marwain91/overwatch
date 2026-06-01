import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { createHash, randomBytes } from 'crypto';

let tmpDir: string;
vi.mock('../config', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, getDataDir: () => tmpDir };
});
vi.mock('../services/users', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, isAdminEmail: vi.fn(async () => true), getUserRole: vi.fn(async () => 'editor') };
});

import { createOAuthRouter } from '../routes/oauth';
import { putAuthCode } from '../oauth/store';
import { verifyAccessToken } from '../oauth/tokens';

const ISSUER = 'https://ow.example.com';
function appWith() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(createOAuthRouter({ issuer: ISSUER }));
  return app;
}

describe('oauth /token', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-oautht-'));
    process.env.JWT_SECRET = 'x'.repeat(40);
  });

  it('exchanges a valid code (PKCE ok) for access + refresh tokens', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    putAuthCode({ code: 'CODE1', client_id: 'c1', redirect_uri: 'https://client/cb', code_challenge: challenge, email: 'a@b.c', role: 'editor', expires_at: Date.now() + 60_000 });

    const res = await request(appWith()).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code: 'CODE1', client_id: 'c1', redirect_uri: 'https://client/cb', code_verifier: verifier,
    });
    expect(res.status).toBe(200);
    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.refresh_token).toMatch(/.+/);
    const info = verifyAccessToken(res.body.access_token, { issuer: ISSUER });
    expect(info.email).toBe('a@b.c');
    expect(info.role).toBe('editor');
  });

  it('rejects a code with a bad PKCE verifier', async () => {
    const challenge = createHash('sha256').update('right').digest('base64url');
    putAuthCode({ code: 'CODE2', client_id: 'c1', redirect_uri: 'https://client/cb', code_challenge: challenge, email: 'a@b.c', role: 'editor', expires_at: Date.now() + 60_000 });
    const res = await request(appWith()).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code: 'CODE2', client_id: 'c1', redirect_uri: 'https://client/cb', code_verifier: 'wrong',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('rotates a refresh token and rejects its reuse', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    putAuthCode({ code: 'CODE3', client_id: 'c1', redirect_uri: 'https://client/cb', code_challenge: challenge, email: 'a@b.c', role: 'editor', expires_at: Date.now() + 60_000 });
    const first = await request(appWith()).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code: 'CODE3', client_id: 'c1', redirect_uri: 'https://client/cb', code_verifier: verifier,
    });
    const rt = first.body.refresh_token;
    const refreshed = await request(appWith()).post('/oauth/token').type('form').send({ grant_type: 'refresh_token', refresh_token: rt });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(rt); // rotated
    const reused = await request(appWith()).post('/oauth/token').type('form').send({ grant_type: 'refresh_token', refresh_token: rt });
    expect(reused.status).toBe(400); // old token no longer valid
  });
});
