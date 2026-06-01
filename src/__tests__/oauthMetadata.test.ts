import { describe, it, expect } from 'vitest';
import { authorizationServerMetadata, protectedResourceMetadata } from '../oauth/metadata';

const ISSUER = 'https://ow.example.com';

describe('oauth metadata', () => {
  it('AS metadata advertises endpoints + PKCE S256', () => {
    const m = authorizationServerMetadata(ISSUER);
    expect(m.issuer).toBe(ISSUER);
    expect(m.authorization_endpoint).toBe('https://ow.example.com/oauth/authorize');
    expect(m.token_endpoint).toBe('https://ow.example.com/oauth/token');
    expect(m.registration_endpoint).toBe('https://ow.example.com/oauth/register');
    expect(m.code_challenge_methods_supported).toContain('S256');
    expect(m.grant_types_supported).toEqual(expect.arrayContaining(['authorization_code', 'refresh_token']));
  });

  it('protected resource metadata points at the AS', () => {
    const m = protectedResourceMetadata(ISSUER);
    expect(m.resource).toBe('https://ow.example.com/mcp');
    expect(m.authorization_servers).toEqual([ISSUER]);
  });
});
