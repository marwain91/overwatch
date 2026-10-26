import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
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
      map: z.record(z.string(), z.string()),
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

  it('throws on object modes it cannot render faithfully', async () => {
    // Loose/catchall objects need index signatures; strict objects only declare
    // known keys, which the generated type can check with excess property checks.
    const gen = (schema: unknown) => generate(new Map<string, unknown>([['X', schema]]), { srcRoot: SRC_ROOT, ts });
    await expect(gen(z.looseObject({ a: z.string() }))).rejects.toThrow(/catchall/);
    await expect(gen(z.object({ a: z.string() }).catchall(z.number()))).rejects.toThrow(/catchall/);
    await expect(gen(z.object({ n: z.looseObject({ a: z.string() }) }))).rejects.toThrow(/catchall/);
  });

  it('renders strict policy objects, including nested refined rules', async () => {
    const Sample = z.strictObject({
      rules: z.array(z.strictObject({ action: z.enum(['allow', 'deny']), path: z.string().optional() }).refine(rule => !!rule.path)),
    });
    const out = await generate(new Map<string, unknown>([['Policy', Sample]]), { srcRoot: SRC_ROOT, ts });
    expect(out).toContain('export interface Policy {');
    expect(out).toContain('action: "allow" | "deny";');
    expect(out).toContain('path?: string;');
    expect(Sample.safeParse({ rules: [{ action: 'allow', path: '/', typo: 'x' }] }).success).toBe(false);
  });

  it('copies the tenant, container, health, metrics, alert and audit types from the backend source', async () => {
    const out: string = await generate(await loadSchemas(), { srcRoot: SRC_ROOT, ts });
    const block = (name: string) => out.match(new RegExp(`export (?:interface|type) ${name}\\b[^]*?\\n\\}`))?.[0] ?? '';
    // The UI had `service` as required; the backend leaves it optional.
    expect(block('ContainerInfo')).toContain('service?: string;');
    expect(block('TenantStatus')).toContain('containers: ContainerInfo[];');
    expect(block('HealthState')).toContain('consecutiveFailures: number;');
    expect(block('HealthState')).toContain('state: HealthStateName;');
    expect(out).toContain("export type HealthStateName = 'healthy' | 'unhealthy' | 'unknown';");
    expect(block('ContainerMetrics')).toContain('memPercent: number;');
    expect(block('MetricsSnapshot')).toContain('tenants: TenantMetrics[];');
    expect(block('AlertHistoryEntry')).toContain('resolvedAt?: string;');
    expect(block('AuditEntry')).toContain('status: number;');
  });

  it('produces a file that type-checks on its own (no copied type refers to a missing name)', async () => {
    const out: string = await generate(await loadSchemas(), { srcRoot: SRC_ROOT, ts });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overwatch-gen-ui-types-'));
    try {
      const file = path.join(dir, 'api-types.generated.ts');
      fs.writeFileSync(file, out);
      const program = ts.createProgram([file], { strict: true, noEmit: true, skipLibCheck: true, types: [], target: ts.ScriptTarget.ES2020 });
      const diagnostics = ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      expect(diagnostics).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
