import inquirer from 'inquirer';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { findConfigPath, loadConfig, clearConfigCache, isUsingLegacyCertResolvers } from '../../config/loader';
import { OverwatchConfigSchema } from '../../config/schema';
import type { CertResolver, TraefikGlobal } from '../../models/traefik';
import { BOLD, CYAN, DIM, GREEN, NC, YELLOW, header, success, warn, info, fail } from './utils';

const execFileAsync = promisify(execFile);

export async function runConfigTraefik(args: string[]): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case 'view':           return view();
    case 'migrate':        return migrate();
    case 'resolver':       return resolver(args.slice(1));
    case 'reload':         return reload();
    case '--help':
    case '-h':
    case undefined:        return showHelp();
    default:
      console.error(`Unknown traefik subcommand: ${sub}`);
      console.error('Run "overwatch config traefik --help" for usage.');
      process.exit(1);
  }
}

function showHelp(): void {
  console.log('');
  console.log(`  ${BOLD}overwatch config traefik${NC} — Manage Traefik configuration`);
  console.log('');
  console.log('  Subcommands:');
  console.log(`    view                          Show resolved Traefik config`);
  console.log(`    resolver list                 List cert resolvers`);
  console.log(`    resolver add ${DIM}[--dns|--http]${NC}    Add a cert resolver (interactive)`);
  console.log(`    resolver remove <name>        Remove a cert resolver`);
  console.log(`    migrate                       Rewrite legacy networking.cert_resolvers as traefik.cert_resolvers`);
  console.log(`    reload                        Restart the Traefik container`);
  console.log('');
  console.log(`  ${DIM}Use the Web UI for middleware library, dashboard auth, and per-tenant overrides.${NC}`);
  console.log('');
}

// ─── view ───────────────────────────────────────────────────────────────────

async function view(): Promise<void> {
  header('Traefik Configuration');
  const cfg = loadConfig();
  if (!cfg.traefik || !cfg.traefik.cert_resolvers || cfg.traefik.cert_resolvers.length === 0) {
    warn('No traefik.cert_resolvers configured.');
    if (isUsingLegacyCertResolvers()) {
      info('Legacy networking.cert_resolvers is in use. Run `overwatch config traefik migrate`.');
    }
    return;
  }
  console.log(yaml.dump(maskedView(cfg.traefik), { lineWidth: 100 }));
}

function maskedView(t: TraefikGlobal): TraefikGlobal {
  const copy: TraefikGlobal = JSON.parse(JSON.stringify(t));
  for (const r of copy.cert_resolvers ?? []) {
    if (r.challenge === 'dns' && r.env) {
      for (const k of Object.keys(r.env)) {
        if (/(_TOKEN|_KEY|_SECRET|_PASSWORD)$/.test(k)) {
          r.env[k] = '••••••••';
        }
      }
    }
  }
  return copy;
}

// ─── resolver ──────────────────────────────────────────────────────────────

async function resolver(args: string[]): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case 'list':    return resolverList();
    case 'add':     return resolverAdd(args.slice(1));
    case 'remove':  return resolverRemove(args[1]);
    default:
      console.error(`Unknown resolver subcommand: ${sub ?? '(none)'}`);
      console.error('Use: overwatch config traefik resolver [list|add|remove <name>]');
      process.exit(1);
  }
}

async function resolverList(): Promise<void> {
  header('Cert Resolvers');
  const cfg = loadConfig();
  const resolvers = cfg.traefik?.cert_resolvers ?? [];
  if (resolvers.length === 0) {
    warn('No cert resolvers defined.');
    return;
  }
  for (const r of resolvers) {
    const challenge = r.challenge.toUpperCase();
    const provider = r.challenge === 'dns' ? r.provider : `entrypoint=${r.entrypoint ?? 'web'}`;
    const patterns = r.domain_patterns?.join(', ') ?? '(none)';
    console.log(`  ${BOLD}${r.name}${NC}  ${DIM}[${challenge}]${NC}`);
    console.log(`    provider:        ${provider}`);
    console.log(`    acme_email:      ${r.acme_email}`);
    console.log(`    domain_patterns: ${patterns}`);
    console.log('');
  }
}

async function resolverAdd(args: string[]): Promise<void> {
  header('Add Cert Resolver');
  const wantDns = args.includes('--dns');
  const wantHttp = args.includes('--http');
  const challengeChoice: 'dns' | 'http' = wantDns ? 'dns' : wantHttp ? 'http' : (await inquirer.prompt([{
    type: 'list', name: 'c', message: 'Challenge type', default: 'dns',
    choices: [
      { name: 'DNS-01 (required for wildcard certs)', value: 'dns' },
      { name: 'HTTP-01 (any publicly-reachable domain)', value: 'http' },
    ],
  }])).c;

  const { name } = await inquirer.prompt([{
    type: 'input', name: 'name', message: 'Resolver name (lowercase, hyphens):',
    validate: (v: string) => /^[a-z0-9][a-z0-9-]*$/.test(v) || 'Lowercase letters, digits, dashes',
  }]);

  const { acmeEmail } = await inquirer.prompt([{
    type: 'input', name: 'acmeEmail', message: 'ACME contact email:',
    validate: (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || 'Invalid email',
  }]);

  let resolverObj: CertResolver;
  if (challengeChoice === 'dns') {
    const { provider } = await inquirer.prompt([{
      type: 'input', name: 'provider', message: 'DNS provider (e.g. cloudflare, gandi, route53):',
      validate: (v: string) => v.trim().length > 0 || 'Required',
    }]);
    const { envVarsRaw } = await inquirer.prompt([{
      type: 'input', name: 'envVarsRaw', message: 'Provider env vars (comma-separated KEY=${VAR}, leave empty for none):',
    }]);
    const env: Record<string, string> = {};
    for (const pair of envVarsRaw.split(',').map((s: string) => s.trim()).filter(Boolean)) {
      const [k, v] = pair.split('=');
      if (k && v) env[k.trim()] = v.trim();
    }
    const { patternsRaw } = await inquirer.prompt([{
      type: 'input', name: 'patternsRaw', message: 'Domain patterns (comma-separated globs, e.g. *.example.com):',
    }]);
    const domain_patterns = patternsRaw.split(',').map((s: string) => s.trim()).filter(Boolean);
    resolverObj = {
      name, challenge: 'dns', provider: provider.trim(), acme_email: acmeEmail,
      env: Object.keys(env).length > 0 ? env : undefined,
      domain_patterns: domain_patterns.length > 0 ? domain_patterns : undefined,
    } as CertResolver;
  } else {
    const { entrypoint } = await inquirer.prompt([{
      type: 'input', name: 'entrypoint', message: 'Entrypoint for HTTP-01 challenge:', default: 'web',
    }]);
    resolverObj = {
      name, challenge: 'http', acme_email: acmeEmail, entrypoint,
    } as CertResolver;
  }

  await mutateConfig(raw => {
    raw.traefik = raw.traefik ?? {};
    raw.traefik.cert_resolvers = raw.traefik.cert_resolvers ?? [];
    const idx = raw.traefik.cert_resolvers.findIndex((r: CertResolver) => r.name === name);
    if (idx >= 0) raw.traefik.cert_resolvers[idx] = resolverObj;
    else raw.traefik.cert_resolvers.push(resolverObj);
  });

  success(`Cert resolver "${name}" added. Run \`overwatch config traefik reload\` to apply.`);
}

async function resolverRemove(name: string | undefined): Promise<void> {
  if (!name) {
    fail('Usage: overwatch config traefik resolver remove <name>');
    process.exit(1);
  }
  await mutateConfig(raw => {
    if (!raw.traefik?.cert_resolvers) return;
    raw.traefik.cert_resolvers = raw.traefik.cert_resolvers.filter((r: CertResolver) => r.name !== name);
  });
  success(`Cert resolver "${name}" removed. Run \`overwatch config traefik reload\` to apply.`);
}

// ─── migrate ────────────────────────────────────────────────────────────────

async function migrate(): Promise<void> {
  header('Migrate to traefik.cert_resolvers');
  if (!isUsingLegacyCertResolvers()) {
    info('No legacy networking.cert_resolvers found. Nothing to migrate.');
    return;
  }
  const cfg = loadConfig();
  const legacy = cfg.networking?.cert_resolvers;
  if (!legacy) {
    info('Nothing to migrate.');
    return;
  }

  console.log(`  Legacy:`);
  console.log(`    wildcard: ${legacy.wildcard}`);
  console.log(`    default:  ${legacy.default}`);
  console.log('');

  const { provider } = await inquirer.prompt([{
    type: 'input', name: 'provider',
    message: 'DNS provider that backs the wildcard resolver (cloudflare, gandi, ...):',
    default: 'cloudflare',
  }]);
  const { acmeEmail } = await inquirer.prompt([{
    type: 'input', name: 'acmeEmail', message: 'ACME email:',
    validate: (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || 'Invalid email',
  }]);
  const { wildcardPattern } = await inquirer.prompt([{
    type: 'input', name: 'wildcardPattern',
    message: 'Wildcard domain pattern (e.g. *.app.example.com):',
    validate: (v: string) => v.startsWith('*.') || 'Must start with *.',
  }]);
  const { envVarKey } = await inquirer.prompt([{
    type: 'input', name: 'envVarKey',
    message: 'Provider API token env var name (leave empty for none):',
    default: provider === 'cloudflare' ? 'CF_DNS_API_TOKEN' : '',
  }]);

  const wildcardResolver: CertResolver = {
    name: legacy.wildcard,
    challenge: 'dns',
    provider,
    acme_email: acmeEmail,
    domain_patterns: [wildcardPattern],
    env: envVarKey ? { [envVarKey]: `\${${envVarKey}}` } : undefined,
  };
  const httpResolver: CertResolver = {
    name: legacy.default,
    challenge: 'http',
    acme_email: acmeEmail,
    entrypoint: 'web',
  };

  await mutateConfig(raw => {
    raw.traefik = raw.traefik ?? {};
    raw.traefik.cert_resolvers = [wildcardResolver, httpResolver];
    if (raw.networking?.cert_resolvers) {
      delete raw.networking.cert_resolvers;
    }
  });

  success('Migration complete.');
  info('Next: review overwatch.yaml, then run `overwatch infra deploy` to regenerate Traefik templates.');
}

// ─── reload ─────────────────────────────────────────────────────────────────

async function reload(): Promise<void> {
  header('Reload Traefik');
  const config = loadConfig();
  const containerName = `${config.project.prefix}-traefik`;
  warn(`Restarting ${containerName} (~5–10s of routing pause)`);
  try {
    await execFileAsync('docker', ['restart', containerName]);
    success(`${containerName} restarted.`);
  } catch (err: any) {
    fail(`Failed: ${err?.message || err}`);
    process.exit(1);
  }
}

// ─── shared helper ──────────────────────────────────────────────────────────

async function mutateConfig(mutate: (raw: any) => void): Promise<void> {
  const configPath = findConfigPath();
  const content = await fs.readFile(configPath, 'utf-8');
  const raw = (yaml.load(content) as any) ?? {};
  mutate(raw);
  // Validate before writing.
  const parse = OverwatchConfigSchema.safeParse(raw);
  if (!parse.success) {
    const errors = parse.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('\n  - ');
    throw new Error(`Resulting overwatch.yaml is invalid:\n  - ${errors}`);
  }
  const tmp = `${configPath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, yaml.dump(raw, { lineWidth: 120, noRefs: true }), { mode: 0o644 });
  await fs.rename(tmp, configPath);
  clearConfigCache();
  void path; // avoid unused import lint
}
