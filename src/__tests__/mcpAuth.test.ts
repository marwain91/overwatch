import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../services/users', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, isAdminEmail: vi.fn(async () => true), getUserRole: vi.fn(async () => 'editor') };
});

import { createTokenVerifier } from '../mcp/auth';
import { issueAccessToken } from '../oauth/tokens';

const ISSUER = 'https://ow.example.com';

describe('createTokenVerifier', () => {
  beforeEach(() => { process.env.JWT_SECRET = 'x'.repeat(40); });

  it('verifies a token and attaches email + current role', async () => {
    const verifier = createTokenVerifier({ issuer: ISSUER });
    const token = issueAccessToken({ email: 'a@b.c', role: 'viewer', issuer: ISSUER, ttl: '1h' });
    const info = await verifier.verifyAccessToken(token);
    expect(info.extra.email).toBe('a@b.c');
    expect(info.extra.role).toBe('editor'); // re-resolved live, not the token's 'viewer'
  });

  it('rejects a token for a removed admin', async () => {
    const users = await import('../services/users');
    (users.isAdminEmail as any).mockResolvedValueOnce(false);
    const verifier = createTokenVerifier({ issuer: ISSUER });
    const token = issueAccessToken({ email: 'gone@b.c', role: 'editor', issuer: ISSUER, ttl: '1h' });
    await expect(verifier.verifyAccessToken(token)).rejects.toThrow();
  });
});
