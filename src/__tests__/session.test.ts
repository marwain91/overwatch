import { describe, it, expect, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { signSession, verifySession, SESSION_AUDIENCE, SESSION_ISSUER } from '../auth/session';
import { issueAccessToken, verifyAccessToken, mcpResourceUrl } from '../oauth/tokens';

const SECRET = 'x'.repeat(40);
const MCP_ISSUER = 'https://ow.example.com';

beforeEach(() => { process.env.JWT_SECRET = SECRET; });

describe('web session tokens', () => {
  it('round-trips email, profile and expiry with the web audience and issuer', () => {
    const token = signSession('a@b.c', { name: 'A', picture: 'http://p' });
    const claims = jwt.decode(token) as jwt.JwtPayload;
    expect(claims.aud).toBe(SESSION_AUDIENCE);
    expect(claims.iss).toBe(SESSION_ISSUER);
    const session = verifySession(token);
    expect(session).toMatchObject({ email: 'a@b.c', name: 'A', picture: 'http://p' });
    expect(session.exp - claims.iat!).toBe(24 * 3600);
  });

  it('gives every session a distinct jti so it can be revoked on logout', () => {
    const a = verifySession(signSession('a@b.c'));
    const b = verifySession(signSession('a@b.c'));
    expect(a.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.jti).not.toBe(a.jti);
  });

  it('still accepts a session issued before jti existed', () => {
    const t = jwt.sign({ email: 'a@b.c' }, SECRET, { expiresIn: '1h', audience: SESSION_AUDIENCE, issuer: SESSION_ISSUER });
    const s = verifySession(t);
    expect(s.email).toBe('a@b.c');
    expect(s.jti).toBeUndefined();
  });

  it('reads JWT_SECRET lazily', () => {
    const token = signSession('a@b.c');
    process.env.JWT_SECRET = 'y'.repeat(40);
    expect(() => verifySession(token)).toThrow();
    expect(verifySession(signSession('a@b.c')).email).toBe('a@b.c');
  });

  it('rejects a token without an audience (pre-upgrade session)', () => {
    const legacy = jwt.sign({ email: 'a@b.c' }, SECRET, { expiresIn: '1h' });
    expect(() => verifySession(legacy)).toThrow();
  });

  it('rejects a token with the right audience but no issuer', () => {
    const t = jwt.sign({ email: 'a@b.c' }, SECRET, { expiresIn: '1h', audience: SESSION_AUDIENCE });
    expect(() => verifySession(t)).toThrow();
  });

  it('rejects a token with the right issuer but a different audience', () => {
    const t = jwt.sign({ email: 'a@b.c' }, SECRET, { expiresIn: '1h', issuer: SESSION_ISSUER, audience: 'other' });
    expect(() => verifySession(t)).toThrow();
  });

  it('rejects an expired token', () => {
    const t = jwt.sign({ email: 'a@b.c' }, SECRET, { expiresIn: '-1s', audience: SESSION_AUDIENCE, issuer: SESSION_ISSUER });
    expect(() => verifySession(t)).toThrow();
  });

  it('rejects an MCP access token (same secret, MCP audience)', () => {
    const mcp = issueAccessToken({ email: 'a@b.c', role: 'admin', issuer: MCP_ISSUER, ttl: '1h' });
    expect(() => verifySession(mcp)).toThrow();
  });

  it('rejects an OAuth consent token (same secret, consent audience)', () => {
    const consent = jwt.sign({ email: 'a@b.c', nonce: 'n' }, SECRET, {
      algorithm: 'HS256', expiresIn: 300, audience: 'mcp-oauth-consent', issuer: MCP_ISSUER,
    });
    expect(() => verifySession(consent)).toThrow();
  });

  it('is rejected by the MCP access-token verifier', () => {
    const session = signSession('a@b.c');
    expect(() => verifyAccessToken(session, { issuer: MCP_ISSUER })).toThrow();
    expect(mcpResourceUrl(MCP_ISSUER)).not.toBe(SESSION_AUDIENCE);
  });
});
