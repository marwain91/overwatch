import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { z } from 'zod';
// @ts-expect-error plain .mjs build script without type declarations
import { generate, SCHEMA_SPECS, OUT_FILE } from '../../scripts/gen-ui-types.mjs';

const SRC_ROOT = path.resolve(__dirname, '..');

async function loadSchemas(): Promise<Map<string, unknown>> {
  const schemas = new Map<string, unknown>();
  for (const [name, mod, exportName] of SCHEMA_SPECS as Array<[string, string, string]>) {
    schemas.set(name, (await import(path.join(SRC_ROOT, mod)))[exportName]);
  }
  return schemas;
}

describe('gen-ui-types', () => {
  it('matches the committed ui/src/lib/api-types.generated.ts (run `npm run build` to refresh)', async () => {
    const generated = await generate(await loadSchemas(), { srcRoot: SRC_ROOT, ts });
    expect(fs.readFileSync(OUT_FILE, 'utf8')).toBe(generated);
  });

  it('is deterministic', async () => {
    const schemas = await loadSchemas();
    expect(await generate(schemas, { srcRoot: SRC_ROOT, ts })).toBe(await generate(schemas, { srcRoot: SRC_ROOT, ts }));
  });

  it('renders optional, defaulted, enum, record and discriminated-union shapes', async () => {
    const Inner = z.object({ a: z.string() });
    const Sample = z.object({
      req: z.string(),
      dflt: z.number().default(3),
      opt: z.array(Inner).optional(),
      kind: z.enum(['x', 'y']),
      map: z.record(z.string()),
      u: z.discriminatedUnion('t', [z.object({ t: z.literal('p') }), z.object({ t: z.literal('q'), n: z.number() })]),
    });
    const out = await generate(new Map<string, unknown>([['Inner', Inner], ['Sample', Sample]]), { srcRoot: SRC_ROOT, ts });
    expect(out).toContain('export interface Sample {');
    expect(out).toContain('  req: string;');
    expect(out).toContain('  dflt?: number;');
    expect(out).toContain('  opt?: Array<Inner>;');
    expect(out).toContain('  kind: "x" | "y";');
    expect(out).toContain('  map: Record<string, string>;');
    expect(out).toMatch(/u: \{\n\s+t: "p";\n\s+\} \| \{\n\s+t: "q";\n\s+n: number;/);
  });

  it('throws on a Zod node it cannot render instead of emitting wrong types', async () => {
    await expect(generate(new Map<string, unknown>([['Bad', z.object({ d: z.date() })]]), { srcRoot: SRC_ROOT, ts })).rejects.toThrow(/unsupported Zod node/);
  });
});
