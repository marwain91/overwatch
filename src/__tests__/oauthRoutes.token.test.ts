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
const ADMIN = { email: 'a@b.c', role: 'editor' as const, addedAt: '2020-01-01T00:00:00.000Z', addedBy: 'x' };
vi.mock('../services/users', async (orig) => {
  const actual = await (orig as any)();
  return {
    ...actual,
    isAdminEmail: vi.fn(async () => true),
    getUserRole: vi.fn(async () => 'editor'),
    listAdminUsers: vi.fn(async () => [ADMIN]),
  };
});
const writeAuditEntry = vi.fn();
vi.mock('../services/auditLog', () => ({ writeAuditEntry: (e: unknown) => writeAuditEntry(e) }));

import { createOAuthRouter } from '../routes/oauth';
import { putAuthCode, saveRefreshToken, registerClient, getClient } from '../oauth/store';
import { verifyAccessToken } from '../oauth/tokens';
import { isAdminEmail, listAdminUsers } from '../services/users';

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
    const refreshed = await request(appWith()).post('/oauth/token').type('form').send({ grant_type: 'refresh_token', client_id: 'c1', refresh_token: rt });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(rt); // rotated
    const reused = await request(appWith()).post('/oauth/token').type('form').send({ grant_type: 'refresh_token', client_id: 'c1', refresh_token: rt });
    expect(reused.status).toBe(400); // old token no longer valid
  });

  it('rejects an unknown/expired authorization code', async () => {
    const res = await request(appWith()).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code: 'NOPE', client_id: 'c1', redirect_uri: 'https://client/cb', code_verifier: 'whatever',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('rejects a redirect_uri that does not match the code', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    putAuthCode({ code: 'CODEx', client_id: 'c1', redirect_uri: 'https://client/cb', code_challenge: challenge, email: 'a@b.c', role: 'editor', expires_at: Date.now() + 60_000 });
    const res = await request(appWith()).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code: 'CODEx', client_id: 'c1', redirect_uri: 'https://client/EVIL', code_verifier: verifier,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('rejects an unsupported grant_type', async () => {
    const res = await request(appWith()).post('/oauth/token').type('form').send({ grant_type: 'password' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported_grant_type');
  });

  it('rejects an unknown refresh token', async () => {
    const res = await request(appWith()).post('/oauth/token').type('form').send({ grant_type: 'refresh_token', client_id: 'c1', refresh_token: 'does-not-exist' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  // Revocation safety: admin removed AFTER the code was issued must be denied at
  // the token endpoint (the handler re-checks isAdminEmail at exchange time).
  it('denies the authorization_code grant when the user is no longer an admin', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    putAuthCode({ code: 'CODE_REVOKED', client_id: 'c1', redirect_uri: 'https://client/cb', code_challenge: challenge, email: 'gone@b.c', role: 'editor', expires_at: Date.now() + 60_000 });
    (isAdminEmail as any).mockResolvedValueOnce(false);
    const res = await request(appWith()).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code: 'CODE_REVOKED', client_id: 'c1', redirect_uri: 'https://client/cb', code_verifier: verifier,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('denies the refresh_token grant when the user is no longer an admin', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    putAuthCode({ code: 'CODE_RT', client_id: 'c1', redirect_uri: 'https://client/cb', code_challenge: challenge, email: 'a@b.c', role: 'editor', expires_at: Date.now() + 60_000 });
    const first = await request(appWith()).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code: 'CODE_RT', client_id: 'c1', redirect_uri: 'https://client/cb', code_verifier: verifier,
    });
    const rt = first.body.refresh_token;
    vi.mocked(listAdminUsers).mockResolvedValueOnce([]);
    const res = await request(appWith()).post('/oauth/token').type('form').send({ grant_type: 'refresh_token', client_id: 'c1', refresh_token: rt });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('rejects an expired refresh token at the token endpoint', async () => {
    await saveRefreshToken('EXPIRED_RT', { client_id: 'c1', email: 'a@b.c', expires_at: Date.now() - 1 });
    const res = await request(appWith()).post('/oauth/token').type('form').send({ grant_type: 'refresh_token', client_id: 'c1', refresh_token: 'EXPIRED_RT' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('answers a refresh_token grant without a refresh_token with invalid_request, not a 500', async () => {
    const res = await request(appWith()).post('/oauth/token').type('form').send({ grant_type: 'refresh_token', client_id: 'c1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('answers a repeated refresh_token parameter with invalid_request, not a 500', async () => {
    const res = await request(appWith()).post('/oauth/token').type('form').send('grant_type=refresh_token&client_id=c1&refresh_token=a&refresh_token=b');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('answers /oauth/revoke with 200 for a repeated token parameter', async () => {
    const res = await request(appWith()).post('/oauth/revoke').type('form').send('token=a&token=b');
    expect(res.status).toBe(200);
  });

  it('revokes a refresh token via /oauth/revoke (subsequent use rejected)', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    putAuthCode({ code: 'CODE_REV', client_id: 'c1', redirect_uri: 'https://client/cb', code_challenge: challenge, email: 'a@b.c', role: 'editor', expires_at: Date.now() + 60_000 });
    const first = await request(appWith()).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code: 'CODE_REV', client_id: 'c1', redirect_uri: 'https://client/cb', code_verifier: verifier,
    });
    const rt = first.body.refresh_token;
    const revoke = await request(appWith()).post('/oauth/revoke').type('form').send({ token: rt });
    expect(revoke.status).toBe(200); // RFC 7009: always 200
    const reuse = await request(appWith()).post('/oauth/token').type('form').send({ grant_type: 'refresh_token', client_id: 'c1', refresh_token: rt });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error).toBe('invalid_grant');
  });

  async function issueCode(code: string, extra: Record<string, unknown> = {}) {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    putAuthCode({ code, client_id: 'c1', redirect_uri: 'https://client/cb', code_challenge: challenge, email: 'a@b.c', role: 'editor', expires_at: Date.now() + 60_000, ...extra } as any);
    return verifier;
  }

  it('rejects a code exchange from a different client_id', async () => {
    const verifier = await issueCode('CODE_CID');
    const res = await request(appWith()).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code: 'CODE_CID', client_id: 'other', redirect_uri: 'https://client/cb', code_verifier: verifier,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('rejects a code exchange without client_id', async () => {
    const verifier = await issueCode('CODE_NOCID');
    const res = await request(appWith()).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code: 'CODE_NOCID', redirect_uri: 'https://client/cb', code_verifier: verifier,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('rejects an unknown resource at code exchange', async () => {
    const verifier = await issueCode('CODE_RES');
    const res = await request(appWith()).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code: 'CODE_RES', client_id: 'c1', redirect_uri: 'https://client/cb', code_verifier: verifier,
      resource: 'https://other.example.com/mcp',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_target');
  });

  it('accepts the MCP resource at code exchange', async () => {
    const verifier = await issueCode('CODE_RES_OK');
    const res = await request(appWith()).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code: 'CODE_RES_OK', client_id: 'c1', redirect_uri: 'https://client/cb', code_verifier: verifier,
      resource: ISSUER + '/mcp',
    });
    expect(res.status).toBe(200);
  });

  it('rejects a refresh token presented by a different client_id without consuming it', async () => {
    await saveRefreshToken('RT_OWNED', { client_id: 'c1', email: 'a@b.c', expires_at: Date.now() + 60_000 });
    const stolen = await request(appWith()).post('/oauth/token').type('form').send({ grant_type: 'refresh_token', client_id: 'evil', refresh_token: 'RT_OWNED' });
    expect(stolen.status).toBe(400);
    expect(stolen.body.error).toBe('invalid_grant');
    const owner = await request(appWith()).post('/oauth/token').type('form').send({ grant_type: 'refresh_token', client_id: 'c1', refresh_token: 'RT_OWNED' });
    expect(owner.status).toBe(200);
  });

  it('a refresh without client_id does not consume the token', async () => {
    await saveRefreshToken('RT_KEEP', { client_id: 'c1', email: 'a@b.c', expires_at: Date.now() + 60_000 });
    const bad = await request(appWith()).post('/oauth/token').type('form').send({ grant_type: 'refresh_token', refresh_token: 'RT_KEEP' });
    expect(bad.status).toBe(400);
    const ok = await request(appWith()).post('/oauth/token').type('form').send({ grant_type: 'refresh_token', client_id: 'c1', refresh_token: 'RT_KEEP' });
    expect(ok.status).toBe(200);
  });

  it('marks the client as used on code exchange and refresh', async () => {
    const client = await registerClient({ client_name: 'c', redirect_uris: ['https://client/cb'] });
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    putAuthCode({ code: 'CODE_USED', client_id: client.client_id, redirect_uri: 'https://client/cb', code_challenge: challenge, email: 'a@b.c', role: 'editor', expires_at: Date.now() + 60_000 });
    expect((await getClient(client.client_id))?.last_used_at).toBeUndefined();
    const first = await request(appWith()).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code: 'CODE_USED', client_id: client.client_id, redirect_uri: 'https://client/cb', code_verifier: verifier,
    });
    expect(first.status).toBe(200);
    expect((await getClient(client.client_id))?.last_used_at).toBeDefined();
  });

  it('rejects a refresh without client_id', async () => {
    await saveRefreshToken('RT_NOCID', { client_id: 'c1', email: 'a@b.c', expires_at: Date.now() + 60_000 });
    const res = await request(appWith()).post('/oauth/token').type('form').send({ grant_type: 'refresh_token', refresh_token: 'RT_NOCID' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('rejects an unknown resource on refresh', async () => {
    await saveRefreshToken('RT_RES', { client_id: 'c1', email: 'a@b.c', expires_at: Date.now() + 60_000 });
    const res = await request(appWith()).post('/oauth/token').type('form').send({ grant_type: 'refresh_token', client_id: 'c1', refresh_token: 'RT_RES', resource: 'https://other/x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_target');
  });

  it('expires_in reflects the configured access token TTL on both grants', async () => {
    const app = express();
    app.use(express.urlencoded({ extended: true }));
    app.use(createOAuthRouter({ issuer: ISSUER, accessTokenTtl: '15m' }));
    const verifier = await issueCode('CODE_TTL');
    const first = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code: 'CODE_TTL', client_id: 'c1', redirect_uri: 'https://client/cb', code_verifier: verifier,
    });
    expect(first.body.expires_in).toBe(900);
    const second = await request(app).post('/oauth/token').type('form').send({ grant_type: 'refresh_token', client_id: 'c1', refresh_token: first.body.refresh_token });
    expect(second.body.expires_in).toBe(900);
  });

  describe('audit trail', () => {
    beforeEach(() => writeAuditEntry.mockReset());

    it('audits the code exchange, a refresh and a revocation', async () => {
      const app = appWith();
      const verifier = await issueCode('CODE_AUDIT');
      const first = await request(app).post('/oauth/token').type('form').send({
        grant_type: 'authorization_code', code: 'CODE_AUDIT', client_id: 'c1', redirect_uri: 'https://client/cb', code_verifier: verifier,
      });
      expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
        user: 'a@b.c', action: 'oauth token issued', path: '/oauth/token', status: 200, body: { client_id: 'c1' },
      }));
      const second = await request(app).post('/oauth/token').type('form').send({ grant_type: 'refresh_token', client_id: 'c1', refresh_token: first.body.refresh_token });
      expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ user: 'a@b.c', action: 'oauth token refreshed', status: 200 }));
      await request(app).post('/oauth/revoke').type('form').send({ token: second.body.refresh_token });
      expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ user: 'a@b.c', action: 'oauth token revoked', path: '/oauth/revoke' }));
      // The audit body never carries a token.
      expect(JSON.stringify(writeAuditEntry.mock.calls)).not.toContain(first.body.refresh_token);
    });

    it('does not audit a revocation of an unknown token', async () => {
      await request(appWith()).post('/oauth/revoke').type('form').send({ token: 'nope' });
      expect(writeAuditEntry).not.toHaveBeenCalled();
    });
  });

  describe('refresh token families', () => {
    const refresh = (app: express.Express, rt: string) =>
      request(app).post('/oauth/token').type('form').send({ grant_type: 'refresh_token', client_id: 'c1', refresh_token: rt });
    async function exchange(app: express.Express, code: string) {
      const verifier = await issueCode(code);
      const res = await request(app).post('/oauth/token').type('form').send({
        grant_type: 'authorization_code', code, client_id: 'c1', redirect_uri: 'https://client/cb', code_verifier: verifier,
      });
      expect(res.status).toBe(200);
      return res.body.refresh_token as string;
    }

    it('presenting a rotated-out refresh token revokes the whole grant and is audited', async () => {
      const app = appWith();
      const rt1 = await exchange(app, 'CODE_FAM');
      const rt2 = (await refresh(app, rt1)).body.refresh_token;
      expect(rt2).toBeTruthy();
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + 60_000); // past the reuse grace window
      try {
        const reuse = await refresh(app, rt1);
        expect(reuse.status).toBe(400);
        expect(reuse.body.error).toBe('invalid_grant');
        expect((await refresh(app, rt2)).status).toBe(400); // the live successor died with the family
      } finally {
        vi.mocked(Date.now).mockRestore();
      }
      expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
        user: 'a@b.c', status: 400, action: expect.stringMatching(/reuse/i), path: '/oauth/token',
      }));
    });

    it('rejects a refresh whose grant predates the account being (re-)added', async () => {
      const app = appWith();
      const rt = await exchange(app, 'CODE_READD');
      vi.mocked(listAdminUsers).mockResolvedValueOnce([{ ...ADMIN, addedAt: new Date(Date.now() + 1_000).toISOString() }]);
      const res = await refresh(app, rt);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_grant');
    });

    it('a refresh token stored before families works once and rotates into a family', async () => {
      await saveRefreshToken('LEGACY_RT', { client_id: 'c1', email: 'a@b.c', expires_at: Date.now() + 30 * 24 * 3600 * 1000 });
      const app = appWith();
      const res = await refresh(app, 'LEGACY_RT');
      expect(res.status).toBe(200);
      const store = JSON.parse(await fs.readFile(path.join(tmpDir, 'mcp-oauth.json'), 'utf8'));
      expect(store.refreshTokens).toHaveLength(1);
      expect(store.refreshTokens[0]).toMatchObject({ family_id: expect.any(String), granted_at: expect.any(Number) });
      expect((await refresh(app, 'LEGACY_RT')).status).toBe(400);
      expect((await refresh(app, res.body.refresh_token)).status).toBe(200);
    });

    it('a legacy refresh token issued before the account was re-added is refused', async () => {
      // Stored with a 30d TTL ten days ago; the admin was re-added yesterday.
      const ttl = 30 * 24 * 3600 * 1000;
      await saveRefreshToken('LEGACY_OLD', { client_id: 'c1', email: 'a@b.c', expires_at: Date.now() - 10 * 86_400_000 + ttl });
      vi.mocked(listAdminUsers).mockResolvedValueOnce([{ ...ADMIN, addedAt: new Date(Date.now() - 86_400_000).toISOString() }]);
      expect((await refresh(appWith(), 'LEGACY_OLD')).status).toBe(400);
    });
  });
});
