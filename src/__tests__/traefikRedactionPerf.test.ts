import { describe, it, expect } from 'vitest';
import { redactAppTraefik, MASK } from '../services/traefikRedaction';

// Editors can store arbitrary text in middleware fields; redacting it for a
// non-admin read must stay linear, or one stored value freezes the server.
function redactPath(path: string): string {
  const out = redactAppTraefik({ middlewares: { rp: { type: 'replacePath', path } } } as any);
  return (out!.middlewares!.rp as any).path;
}

describe('traefik redaction cost', () => {
  it('handles a 100k-character value in well under a second', () => {
    const started = Date.now();
    const shown = redactPath('?'.repeat(100_000));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(shown).toBe(MASK);
  });

  it('stays fast just under the visible-text limit', () => {
    const value = '/a' + '?'.repeat(2000);
    const started = Date.now();
    const shown = redactPath(value);
    expect(Date.now() - started).toBeLessThan(200);
    expect(shown).toBe(value);
  });

  it('still hides credential-named parameters and shows plain ones', () => {
    expect(redactPath('/go?token=abc')).toBe(MASK);
    expect(redactPath('/go?a=1;Session_Id=abc')).toBe(MASK);
    expect(redactPath('/go#%74oken=abc')).toBe(MASK);
    expect(redactPath('/go?page=2&sort=asc')).toBe('/go?page=2&sort=asc');
  });
});
