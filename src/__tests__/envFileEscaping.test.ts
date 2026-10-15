import { describe, it, expect } from 'vitest';
import { formatEnvLine } from '../services/envVars';
import { parseEnv, unquoteEnvValue } from '../utils/env';

describe('formatEnvLine', () => {
  it('leaves values that compose reads verbatim unquoted', () => {
    expect(formatEnvLine('A', 'plain value#x \\ "q"')).toBe('A=plain value#x \\ "q"');
    expect(formatEnvLine('A', "it's")).toBe("A=it's");
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

  // compose cuts an unquoted value at " #" (an inline comment).
  it('quotes values holding " #", which compose would truncate', () => {
    expect(formatEnvLine('V', 'pass #1')).toBe("V='pass #1'");
    expect(formatEnvLine('V', "it's #1")).toBe('V="it\'s #1"');
  });

  // compose parses a value starting with a quote as a quoted value: it strips
  // the quotes, or fails on an unterminated one and takes the compose down.
  it('quotes values that start with a quote character', () => {
    expect(formatEnvLine('V', "'sq'")).toBe(`V="'sq'"`);
    expect(formatEnvLine('V', '"dq')).toBe(`V='"dq'`);
  });

  // compose skips a closing single quote preceded by a backslash and reads the
  // following lines into the value, so a trailing backslash needs double quotes.
  it('never single-quotes a value ending with a backslash', () => {
    expect(formatEnvLine('V', '$x\\')).toBe('V="\\$x\\\\"');
    expect(formatEnvLine('V', ' x\\')).toBe('V=" x\\\\"');
  });

  it.each([
    ' lead and trail ', '	Tabbed	', ' x', 'x ', "  it's  ", ' $HOME ', 'plain', 'a b', '$x', '', "q'", ' "dq" ',
    'pass #1', "it's #1", 'a\t#b', "'sq'", '"dq', '"dq"', "'", '"', '$x\\', ' x\\', "it's $x\\", '\\', 'a\\nb',
    'C:\\path\\', '#lead', 'x=y', '${A:-b}',
  ])('round-trips %j through the file format', raw => {
    const line = formatEnvLine('V', raw);
    expect(unquoteEnvValue(parseEnv(`${line}\n`).V ?? '')).toBe(raw);
  });
});
