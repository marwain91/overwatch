import { describe, it, expect, vi, afterEach } from 'vitest';
import { runConfigDocs } from '../cli/config/docs';

// Captures everything runConfigDocs writes via console.log into one string.
async function capture(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    await fn();
    return lines.join('\n');
  } finally {
    spy.mockRestore();
  }
}

describe('overwatch config docs', () => {
  afterEach(() => vi.restoreAllMocks());

  // runConfigDocs walks OverwatchConfigSchema via zod internals. This whole suite
  // exists because that walker is easy to break on a zod upgrade (the command has
  // no other coverage) — e.g. the zod 3 -> 4 migration changed _def to _zod.def,
  // enum values to entries, array type to element, shape() to a shape property,
  // defaultValue() to a value, and moved descriptions to the .description getter.
  it('renders the full configuration reference from the live schema', async () => {
    const out = await capture(() => runConfigDocs([]));
    expect(out).toContain('database.port');
    expect(out).toMatch(/database\.port[\s\S]*?Type:\s+number/);          // array/number node
    expect(out).toMatch(/database\.port[\s\S]*?Default:\s+3306/);          // ZodDefault value
    expect(out).toContain('Database port');                               // .describe() text
    expect(out).toContain('enum(mysql|mariadb|postgres)');                // enum entries
    expect(out).toContain('monitoring.enabled');                          // nested-object recursion
  });

  it('filters output to a single top-level section', async () => {
    const out = await capture(() => runConfigDocs(['database']));
    expect(out).toContain('database.port');
    expect(out).not.toContain('monitoring.enabled');
  });
});
