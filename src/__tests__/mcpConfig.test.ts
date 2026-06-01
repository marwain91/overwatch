import { describe, it, expect } from 'vitest';
import { McpConfigSchema } from '../config/mcp';

describe('McpConfigSchema', () => {
  it('defaults to disabled with standard TTLs', () => {
    const parsed = McpConfigSchema.parse({});
    expect(parsed.enabled).toBe(false);
    expect(parsed.access_token_ttl).toBe('1h');
    expect(parsed.refresh_token_ttl).toBe('30d');
    expect(parsed.public_url).toBe('');
  });

  it('accepts an enabled config with a public_url', () => {
    const parsed = McpConfigSchema.parse({ enabled: true, public_url: 'https://ow.example.com' });
    expect(parsed.enabled).toBe(true);
    expect(parsed.public_url).toBe('https://ow.example.com');
  });
});

import { validateEnvironment } from '../config/validate';
import type { OverwatchConfig } from '../config/schema';

function baseConfig(overrides: Partial<OverwatchConfig> = {}): OverwatchConfig {
  return {
    project: { name: 'p', prefix: 'p', db_prefix: 'p' },
    database: { type: 'mysql', host: 'db', port: 3306, root_user: 'root', root_password_env: 'MYSQL_ROOT_PASSWORD', container_name: 'db' },
    ...overrides,
  } as OverwatchConfig;
}

describe('validateEnvironment — mcp', () => {
  it('errors when mcp.enabled but public_url is blank', () => {
    process.env.JWT_SECRET = 'x'.repeat(32);
    process.env.GOOGLE_CLIENT_ID = 'cid';
    process.env.MYSQL_ROOT_PASSWORD = 'pw';
    const errors = validateEnvironment(baseConfig({ mcp: { enabled: true, public_url: '', access_token_ttl: '1h', refresh_token_ttl: '30d' } }));
    expect(errors.some(e => e.category === 'mcp' && /public_url/.test(e.message))).toBe(true);
  });

  it('no mcp error when disabled', () => {
    process.env.JWT_SECRET = 'x'.repeat(32);
    process.env.GOOGLE_CLIENT_ID = 'cid';
    process.env.MYSQL_ROOT_PASSWORD = 'pw';
    const errors = validateEnvironment(baseConfig({ mcp: { enabled: false, public_url: '', access_token_ttl: '1h', refresh_token_ttl: '30d' } }));
    expect(errors.some(e => e.category === 'mcp')).toBe(false);
  });
});
