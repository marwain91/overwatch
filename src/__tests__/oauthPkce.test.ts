import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'crypto';
import { verifyPkceS256 } from '../oauth/pkce';

function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

describe('verifyPkceS256', () => {
  it('accepts a matching verifier', () => {
    const verifier = randomBytes(32).toString('base64url');
    expect(verifyPkceS256(verifier, challengeFor(verifier))).toBe(true);
  });
  it('rejects a non-matching verifier', () => {
    const verifier = randomBytes(32).toString('base64url');
    expect(verifyPkceS256('wrong', challengeFor(verifier))).toBe(false);
  });
  it('rejects empty inputs', () => {
    expect(verifyPkceS256('', '')).toBe(false);
  });
});
