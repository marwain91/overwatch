import { describe, it, expect } from 'vitest';
import { AppRegistryAuthSchema } from '../models/app';

describe('AppRegistryAuthSchema — github_app discriminator', () => {
  it('accepts type=github_app with all three *_env fields', () => {
    const result = AppRegistryAuthSchema.safeParse({
      type: 'github_app',
      app_id_env: 'GH_APP_ID',
      installation_id_env: 'GH_APP_INSTALLATION_ID',
      private_key_env: 'GH_APP_PRIVATE_KEY',
    });
    expect(result.success).toBe(true);
  });

  it('rejects type=github_app missing app_id_env, naming the field', () => {
    const result = AppRegistryAuthSchema.safeParse({
      type: 'github_app',
      installation_id_env: 'X',
      private_key_env: 'Y',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'app_id_env')).toBe(true);
    }
  });

  it('rejects type=github_app missing installation_id_env', () => {
    const result = AppRegistryAuthSchema.safeParse({
      type: 'github_app',
      app_id_env: 'X',
      private_key_env: 'Y',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'installation_id_env')).toBe(true);
    }
  });

  it('rejects type=github_app missing private_key_env', () => {
    const result = AppRegistryAuthSchema.safeParse({
      type: 'github_app',
      app_id_env: 'X',
      installation_id_env: 'Y',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'private_key_env')).toBe(true);
    }
  });

  it('still accepts the legacy type=token shape', () => {
    const result = AppRegistryAuthSchema.safeParse({
      type: 'token',
      token_env: 'GHCR_TOKEN',
    });
    expect(result.success).toBe(true);
  });

  it('does not require github-app fields when type=token, even if extra fields are absent', () => {
    const result = AppRegistryAuthSchema.safeParse({
      type: 'token',
      username_env: 'GHCR_USERNAME',
      token_env: 'GHCR_TOKEN',
    });
    expect(result.success).toBe(true);
  });
});
