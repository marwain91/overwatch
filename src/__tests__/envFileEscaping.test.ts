import { describe, it, expect } from 'vitest';
import { formatEnvLine } from '../services/envVars';

describe('formatEnvLine', () => {
  it('leaves values without a dollar sign verbatim', () => {
    expect(formatEnvLine('A', 'plain value #x \\ "q"')).toBe('A=plain value #x \\ "q"');
  });

  it('single-quotes values with $ so compose reads them literally', () => {
    expect(formatEnvLine('A', 'pa$$w${X}rd')).toBe("A='pa$$w${X}rd'");
  });

  it('uses an escaped double-quoted form when the value also holds a single quote', () => {
    expect(formatEnvLine('A', `it's $x \\ "q"`)).toBe('A="it\'s \\$x \\\\ \\"q\\""');
  });
});
