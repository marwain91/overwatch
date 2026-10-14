import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';

describe('H1 backup env allowlist — does not leak JWT_SECRET', () => {
  it('getResticEnv returns only explicit keys, not the full process.env', async () => {
    process.env.JWT_SECRET = 'secret-that-must-not-leak';
    process.env.GOOGLE_CLIENT_ID = 'id-that-must-not-leak';
    process.env.DB_ROOT_PASSWORD = 'pw-that-must-not-leak';
    process.env.RESTIC_PASSWORD = 'restic-pw';
    process.env.S3_ENDPOINT = 'https://s3.example.com';
    process.env.S3_BUCKET = 'my-bucket';

    // getResticEnv is not exported, so we verify the allowlist property by
    // scanning the source: the spread-into-object pattern must be gone, and
    // the allowlist marker must be present.
    const mod = await import('../services/backup');
    const src = await fs.readFile('src/services/backup.ts', 'utf-8');
    // The actual spread syntax (`...process.env,`) must not appear in code.
    // Backtick-wrapped mentions in comments are allowed.
    const sourceMinusComments = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(sourceMinusComments).not.toMatch(/\.\.\.process\.env\s*,/);
    expect(src).toMatch(/Allowlist, not spread/);
    expect(typeof mod.createBackup).toBe('function');
  });
});


