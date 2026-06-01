import { describe, it, expect, beforeEach } from 'vitest';
import { issueAccessToken, verifyAccessToken, mcpResourceUrl } from '../oauth/tokens';

const ISSUER = 'https://ow.example.com';

describe('access tokens', () => {
  beforeEach(() => { process.env.JWT_SECRET = 'x'.repeat(40); });

  it('round-trips a valid token with role + audience', () => {
    const token = issueAccessToken({ email: 'a@b.c', role: 'editor', issuer: ISSUER, ttl: '1h' });
    const info = verifyAccessToken(token, { issuer: ISSUER });
    expect(info.email).toBe('a@b.c');
    expect(info.role).toBe('editor');
    expect(info.aud).toBe(mcpResourceUrl(ISSUER));
    expect(info.scope).toBe('tenants');
    expect(info).toHaveProperty('exp');
    expect(typeof info.exp).toBe('number');
  });

  it('rejects a token with the wrong audience', () => {
    const token = issueAccessToken({ email: 'a@b.c', role: 'editor', issuer: ISSUER, ttl: '1h' });
    expect(() => verifyAccessToken(token, { issuer: 'https://other.example.com' })).toThrow();
  });

  it('rejects an expired token', () => {
    const token = issueAccessToken({ email: 'a@b.c', role: 'editor', issuer: ISSUER, ttl: '-1s' });
    expect(() => verifyAccessToken(token, { issuer: ISSUER })).toThrow();
  });

  it('rejects a tampered token', () => {
    const token = issueAccessToken({ email: 'a@b.c', role: 'editor', issuer: ISSUER, ttl: '1h' });
    expect(() => verifyAccessToken(token + 'x', { issuer: ISSUER })).toThrow();
  });
});
