import { describe, it, expect } from 'vitest';
import { formatEnvLine } from '../services/envVars';
import { parseEnv, unquoteEnvValue } from '../utils/env';

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

  it('quotes values with leading or trailing whitespace', () => {
    expect(formatEnvLine('V', ' lead and trail ')).toBe("V=' lead and trail '");
    expect(formatEnvLine('V', "it's ")).toBe('V="it\'s "');
  });

  it.each([
    ' lead and trail ', '	Tabbed	', ' x', 'x ', "  it's  ", ' $HOME ', 'plain', 'a b', '$x', '', "q'", ' "dq" ',
  ])('round-trips %j through the file format', raw => {
    const line = formatEnvLine('V', raw);
    expect(unquoteEnvValue(parseEnv(`${line}\n`).V ?? '')).toBe(raw);
  });
});
