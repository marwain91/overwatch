import { describe, it, expect } from 'vitest';
import { validateEnvVarKey, validateEnvVarValue } from '../services/envVars';

describe('C3 env var value validation — blocks newline/CR/NUL injection', () => {
  it('accepts ordinary values', () => {
    expect(validateEnvVarValue('hello world').valid).toBe(true);
    expect(validateEnvVarValue('P@ssw0rd!$%').valid).toBe(true);
    expect(validateEnvVarValue('').valid).toBe(true);
  });

  it('rejects embedded newline (would inject extra KEY=VALUE line in shared.env)', () => {
    const v = validateEnvVarValue('foo\nDB_PASSWORD=pwned');
    expect(v.valid).toBe(false);
    expect(v.error).toMatch(/newline/i);
  });

  it('rejects CR and NUL', () => {
    expect(validateEnvVarValue('foo\rbar').valid).toBe(false);
    expect(validateEnvVarValue('foo\x00bar').valid).toBe(false);
  });
});

describe('M6 PROTECTED_KEYS check — case/whitespace cannot bypass', () => {
  it('rejects a protected key with surrounding whitespace', () => {
    const v = validateEnvVarKey(' DB_PASSWORD ');
    expect(v.valid).toBe(false);
    expect(v.error).toMatch(/protected/i);
  });

  it('still enforces the uppercase-format rule for obvious bypasses', () => {
    // normalise only trims — lowercase must still fail the format check
    const v = validateEnvVarKey('db_password');
    expect(v.valid).toBe(false);
    expect(v.error).toMatch(/format/i);
  });

  it('accepts normal, non-protected keys', () => {
    expect(validateEnvVarKey('MY_CUSTOM_VAR').valid).toBe(true);
  });

  it('rejects padded keys, which would be written into shared.env verbatim', () => {
    expect(validateEnvVarKey('FOO\n').valid).toBe(false);
    expect(validateEnvVarKey(' FOO').valid).toBe(false);
  });
});


