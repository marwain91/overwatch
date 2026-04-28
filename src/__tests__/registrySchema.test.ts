import { describe, it, expect } from 'vitest';
import { AppRegistryAuthSchema, AppRegistrySchema } from '../models/app';

describe('AppRegistryAuthSchema — supported types', () => {
  it('accepts type=token with token_env', () => {
    const result = AppRegistryAuthSchema.safeParse({
      type: 'token',
      token_env: 'GHCR_TOKEN',
    });
    expect(result.success).toBe(true);
  });

  it('accepts type=basic with username_env + token_env', () => {
    const result = AppRegistryAuthSchema.safeParse({
      type: 'basic',
      username_env: 'REG_USERNAME',
      token_env: 'REG_PASSWORD',
    });
    expect(result.success).toBe(true);
  });

  it('accepts type=aws_iam with aws_region_env', () => {
    const result = AppRegistryAuthSchema.safeParse({
      type: 'aws_iam',
      aws_region_env: 'AWS_REGION',
    });
    expect(result.success).toBe(true);
  });

  it('rejects the removed github_app type (v1.6.7+)', () => {
    const result = AppRegistryAuthSchema.safeParse({
      type: 'github_app',
      app_id_env: 'X',
      installation_id_env: 'Y',
      private_key_env: 'Z',
    });
    expect(result.success).toBe(false);
  });
});

describe('AppRegistrySchema — gitlab type', () => {
  const validAuth = { type: 'token' as const, token_env: 'GITLAB_TOKEN' };

  it('accepts type=gitlab without api_url (SaaS)', () => {
    const result = AppRegistrySchema.safeParse({
      type: 'gitlab',
      url: 'registry.gitlab.com',
      repository: 'mygroup/myproject',
      auth: validAuth,
    });
    expect(result.success).toBe(true);
  });

  it('accepts type=gitlab with api_url (self-hosted)', () => {
    const result = AppRegistrySchema.safeParse({
      type: 'gitlab',
      url: 'registry.acme.com:5050',
      api_url: 'https://gitlab.acme.com',
      repository: 'group/sub/project',
      auth: validAuth,
    });
    expect(result.success).toBe(true);
  });

  it('round-trips api_url through the schema', () => {
    const result = AppRegistrySchema.parse({
      type: 'gitlab',
      url: 'registry.gitlab.com',
      api_url: 'https://gitlab.example.com',
      repository: 'g/p',
      auth: validAuth,
    });
    expect(result.api_url).toBe('https://gitlab.example.com');
  });

  it('still accepts the legacy ghcr shape without api_url', () => {
    const result = AppRegistrySchema.safeParse({
      type: 'ghcr',
      url: 'ghcr.io',
      repository: 'org/repo',
      auth: validAuth,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.api_url).toBeUndefined();
    }
  });
});
