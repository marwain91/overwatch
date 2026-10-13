#!/usr/bin/env node
// Generate ui/src/lib/api-types.generated.ts from the backend Zod schemas (and
// a few plain interfaces) so the React UI cannot drift from the API contract.
//
// Zod schemas are walked via their public `_def` (zod v3) and rendered as the
// z.input shape: fields with defaults are optional, because that is what the
// API accepts and what stored JSON may contain. Schemas are loaded from dist/
// (this runs right after tsc in `npm run build`); the drift test in
// src/__tests__/genUiTypes.test.ts feeds the same renderer from src/.
// Interfaces that have no Zod schema are copied verbatim from the backend
// source with the TypeScript compiler API.

import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT_FILE = path.join(ROOT, 'ui', 'src', 'lib', 'api-types.generated.ts');

// Exported name in the generated file -> [module under src/, schema export].
// Order here is the order in the output.
export const SCHEMA_SPECS = [
  ['AppRegistryAuth', 'models/app', 'AppRegistryAuthSchema'],
  ['AppRegistry', 'models/app', 'AppRegistrySchema'],
  ['AppHealthCheck', 'models/app', 'AppHealthCheckSchema'],
  ['AppBackupPath', 'models/app', 'AppBackupPathSchema'],
  ['AppServiceBackup', 'models/app', 'AppServiceBackupSchema'],
  ['AppServiceRouting', 'models/app', 'AppServiceRoutingSchema'],
  ['AppServiceVolume', 'models/app', 'AppServiceVolumeSchema'],
  ['AppService', 'models/app', 'AppServiceSchema'],
  ['AppBackup', 'models/app', 'AppBackupSchema'],
  ['AppAdminAccess', 'models/app', 'AppAdminAccessSchema'],
  ['AppCredentials', 'models/app', 'AppCredentialsSchema'],
  ['AppManifest', 'models/app', 'AppManifestSchema'],
  ['AppEnvVarDeclaration', 'models/app', 'AppEnvVarDeclarationSchema'],
  ['AppDefinition', 'models/app', 'AppDefinitionSchema'],
  ['CreateApp', 'models/app', 'CreateAppSchema'],
  ['TlsTermination', 'models/traefik', 'TlsTerminationSchema'],
  ['MiddlewareSpec', 'models/traefik', 'MiddlewareSpecSchema'],
  ['CertResolverDns', 'models/traefik', 'CertResolverDnsSchema'],
  ['CertResolverHttp', 'models/traefik', 'CertResolverHttpSchema'],
  ['CertResolver', 'models/traefik', 'CertResolverSchema'],
  ['Entrypoint', 'models/traefik', 'EntrypointSchema'],
  ['TraefikDashboard', 'models/traefik', 'TraefikDashboardSchema'],
  ['TraefikOverwatchRouting', 'models/traefik', 'TraefikOverwatchSchema'],
  ['TraefikGlobal', 'models/traefik', 'TraefikGlobalSchema'],
  ['TraefikApp', 'models/traefik', 'TraefikAppSchema'],
  ['TraefikTenant', 'models/traefik', 'TraefikTenantSchema'],
];

// [file under src/, declaration names] copied verbatim (no Zod schema exists).
export const SOURCE_SPECS = [
  ['services/users.ts', ['AdminRole', 'AdminUser']],
  ['services/backup.ts', ['BackupSnapshot', 'LockInfo']],
  ['notifications/types.ts', ['WebhookConfig', 'NotificationChannel']],
  ['services/envVars.ts', ['EnvVar']],
];

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const q = (s) => JSON.stringify(s);

function render(schema, names, indent, isRoot = false) {
  if (!isRoot && names.has(schema)) return names.get(schema);
  const def = schema._def;
  const sub = (s) => render(s, names, indent);
  switch (def.typeName) {
    case 'ZodString': return 'string';
    case 'ZodNumber': return 'number';
    case 'ZodBoolean': return 'boolean';
    case 'ZodLiteral': return q(def.value);
    case 'ZodEnum': return def.values.map(q).join(' | ');
    case 'ZodOptional':
    case 'ZodDefault': return sub(def.innerType);
    case 'ZodNullable': return `${sub(def.innerType)} | null`;
    case 'ZodEffects': return render(def.schema, names, indent);
    case 'ZodArray': return `Array<${sub(def.type)}>`;
    case 'ZodRecord': return `Record<string, ${sub(def.valueType)}>`;
    case 'ZodUnion': return def.options.map(sub).join(' | ');
    case 'ZodDiscriminatedUnion': return [...def.options.values()].map(sub).join(' | ');
    case 'ZodObject': {
      const pad = '  '.repeat(indent + 1);
      const lines = Object.entries(schema.shape).map(([key, value]) => {
        const k = IDENT.test(key) ? key : q(key);
        return `${pad}${k}${value.isOptional() ? '?' : ''}: ${render(value, names, indent + 1)};`;
      });
      return lines.length ? `{\n${lines.join('\n')}\n${'  '.repeat(indent)}}` : 'Record<string, never>';
    }
    default:
      throw new Error(`gen-ui-types: unsupported Zod node ${def.typeName}; extend render()`);
  }
}

async function extractDeclarations(ts, srcRoot, file, wanted) {
  const full = path.join(srcRoot, file);
  const text = await fs.readFile(full, 'utf8');
  const sf = ts.createSourceFile(full, text, ts.ScriptTarget.ES2020, true);
  const byName = new Map();
  for (const node of sf.statements) {
    if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && wanted.includes(node.name.text)) {
      const body = node.getText(sf);
      byName.set(node.name.text, body.startsWith('export ') ? body : `export ${body}`);
    }
  }
  return wanted.map((name) => {
    if (!byName.has(name)) throw new Error(`gen-ui-types: ${name} not found in src/${file}`);
    return byName.get(name);
  });
}

/**
 * @param {Map<string, any>} schemas  exported name -> Zod schema
 * @param {{ srcRoot: string, ts: any }} opts
 */
export async function generate(schemas, { srcRoot, ts }) {
  const names = new Map();
  for (const [name, schema] of schemas) names.set(schema, name);

  const out = [
    '// AUTO-GENERATED by scripts/gen-ui-types.mjs from the backend Zod schemas — DO NOT EDIT.',
    '// Run `npm run build` (or `node scripts/gen-ui-types.mjs`) to regenerate.',
    '// Zod-derived types use the schema *input* shape: fields with defaults are optional.',
    '',
  ];
  for (const [name, schema] of schemas) {
    const body = render(schema, names, 0, true);
    out.push(schema._def.typeName === 'ZodObject' ? `export interface ${name} ${body}` : `export type ${name} = ${body};`, '');
  }
  for (const [file, wanted] of SOURCE_SPECS) {
    for (const decl of await extractDeclarations(ts, srcRoot, file, wanted)) out.push(decl, '');
  }
  return out.join('\n');
}

async function main() {
  const require = createRequire(import.meta.url);
  const dist = path.join(ROOT, 'dist');
  const schemas = new Map();
  for (const [name, mod, exportName] of SCHEMA_SPECS) {
    const schema = require(path.join(dist, mod))[exportName];
    if (!schema) throw new Error(`gen-ui-types: ${exportName} missing from dist/${mod}`);
    schemas.set(name, schema);
  }
  const ts = require('typescript');
  const content = await generate(schemas, { srcRoot: path.join(ROOT, 'src'), ts });
  await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
  await fs.writeFile(OUT_FILE, content, 'utf8');
  console.log(`[gen-ui-types] wrote ${path.relative(ROOT, OUT_FILE)} (${schemas.size} schemas)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
