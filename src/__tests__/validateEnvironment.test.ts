import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateEnvironment } from '../config/validate';
import type { OverwatchConfig } from '../config/schema';

const config = {
  project: { name: 'p', prefix: 'p', db_prefix: 'p' },
  database: { type: 'mysql', host: 'db', port: 3306, root_user: 'root', root_password_env: 'MYSQL_ROOT_PASSWORD', container_name: 'db' },
} as OverwatchConfig;

const saved = { ...process.env };

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = 'cid';
  process.env.MYSQL_ROOT_PASSWORD = 'pw';
});

afterEach(() => {
  process.env = { ...saved };
});

describe('validateEnvironment — JWT_SECRET', () => {
  it('rejects the public .env.example placeholder even though it is long enough', () => {
    process.env.JWT_SECRET = 'replace-with-at-least-32-random-characters';
    const errors = validateEnvironment(config);
    expect(errors.some(e => e.category === 'core' && /placeholder/.test(e.message))).toBe(true);
  });

  it('accepts a random secret', () => {
    process.env.JWT_SECRET = 'f3a9c1d27b8e4065a1c2d3e4f5061728';
    expect(validateEnvironment(config)).toEqual([]);
  });
});
