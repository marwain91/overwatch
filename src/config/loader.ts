import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { OverwatchConfigSchema, OverwatchConfig } from './schema';
import type { AppDefinition } from '../models/app';
import type { CertResolver, MiddlewareSpec, TraefikApp, TraefikGlobal } from '../models/traefik';

let cachedConfig: OverwatchConfig | null = null;
let legacyShimWarned = false;

/**
 * Apply backwards-compat shim: if `traefik.cert_resolvers` is absent but
 * `networking.cert_resolvers: {wildcard, default}` is present, synthesize the
 * equivalent named list at load time. The synthesized entries have placeholder
 * provider/email fields — the existing static `traefik.yml` template still
 * carries the real values for legacy installs, so this shim is only used for
 * runtime cert-resolver name lookup, not template regeneration. Run
 * `overwatch config traefik migrate` to rewrite the config in the new shape.
 */
function applyLegacyTraefikShim(config: OverwatchConfig): OverwatchConfig {
  if (config.traefik?.cert_resolvers && config.traefik.cert_resolvers.length > 0) {
    return config;
  }
  const legacy = config.networking?.cert_resolvers;
  if (!legacy) return config;

  if (!legacyShimWarned) {
    process.stderr.write(
      '[33mDEPRECATION: networking.cert_resolvers is deprecated. ' +
      'Run `overwatch config traefik migrate` to upgrade to traefik.cert_resolvers.[0m\n'
    );
    legacyShimWarned = true;
  }

  const synthesized: CertResolver[] = [
    {
      name: legacy.wildcard,
      challenge: 'dns',
      provider: 'legacy',
      acme_email: 'legacy@overwatch.local',
      domain_patterns: ['*'],
    },
    {
      name: legacy.default,
      challenge: 'http',
      acme_email: 'legacy@overwatch.local',
      entrypoint: 'web',
    },
  ];

  return {
    ...config,
    traefik: {
      log_level: 'INFO',
      ...(config.traefik ?? {}),
      cert_resolvers: synthesized,
    },
  };
}

/**
 * Whether the loaded config used the legacy cert_resolvers shim. Generators
 * use this to decide whether to regenerate `traefik.yml` (no — legacy installs
 * keep their hand-rolled template) or treat config as authoritative (yes).
 */
export function isUsingLegacyCertResolvers(): boolean {
  const raw = loadRawConfig();
  const hasNew = raw?.traefik?.cert_resolvers && Array.isArray(raw.traefik.cert_resolvers) && raw.traefik.cert_resolvers.length > 0;
  const hasLegacy = !!raw?.networking?.cert_resolvers;
  return hasLegacy && !hasNew;
}

/**
 * Find the overwatch.yaml config file by searching common locations.
 * Priority: OVERWATCH_CONFIG env > cwd > cwd/overwatch/ > parent dir > /opt/{name}/deploy/overwatch/
 */
export function findConfigPath(): string {
  // 1. Explicit env var
  if (process.env.OVERWATCH_CONFIG) {
    return process.env.OVERWATCH_CONFIG;
  }

  const cwd = process.cwd();
  const candidates = [
    // 2. Direct in cwd (running from inside overwatch/ dir)
    path.join(cwd, 'overwatch.yaml'),
    // 3. In overwatch/ subdir (running from deploy root)
    path.join(cwd, 'overwatch', 'overwatch.yaml'),
    // 4. Parent dir (running from a sibling dir)
    path.join(cwd, '..', 'overwatch', 'overwatch.yaml'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // 5. Scan /opt/*/deploy/overwatch/ (common init default)
  try {
    const optDirs = fs.readdirSync('/opt');
    for (const dir of optDirs) {
      const candidate = path.join('/opt', dir, 'deploy', 'overwatch', 'overwatch.yaml');
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {
    // /opt doesn't exist or isn't readable
  }

  throw new Error(
    'Configuration file not found.\n' +
    '  Searched: ./overwatch.yaml, ./overwatch/overwatch.yaml, /opt/*/deploy/overwatch/overwatch.yaml\n' +
    '  Set OVERWATCH_CONFIG env var to specify the path, or run from the deploy directory.',
  );
}

/**
 * Load and validate the Overwatch configuration from YAML file.
 * Searches common locations for overwatch.yaml (see findConfigPath).
 */
export function loadConfig(): OverwatchConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const configPath = findConfigPath();

  const fileContent = fs.readFileSync(configPath, 'utf-8');
  const rawConfig = yaml.load(fileContent);

  // Validate and parse with Zod
  const parseResult = OverwatchConfigSchema.safeParse(rawConfig);

  if (!parseResult.success) {
    const errors = parseResult.error.errors
      .map(e => `  - ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${errors}`);
  }

  cachedConfig = applyLegacyTraefikShim(parseResult.data);
  return cachedConfig;
}

/**
 * Match a domain against a Traefik-style glob pattern.
 * Supports leading `*.` (matches any single label or chain) and bare `*` (matches anything).
 * Otherwise exact match.
 */
export function domainMatchesPattern(domain: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2);
    return domain === base || domain.endsWith(`.${base}`);
  }
  return domain === pattern;
}

/**
 * Resolve which cert resolver applies to a given tenant domain.
 *
 * Order:
 *   1. explicit `tenantOverride` (if it names a real resolver)
 *   2. longest matching `domain_patterns` across resolvers
 *   3. first http-challenge resolver with no patterns (implicit fallback)
 *   4. error
 */
export function resolveCertResolver(
  domain: string,
  traefik: TraefikGlobal | undefined,
  tenantOverride?: string,
): { name: string; resolver: CertResolver | null } {
  const resolvers = traefik?.cert_resolvers ?? [];

  if (tenantOverride) {
    const r = resolvers.find(x => x.name === tenantOverride);
    if (!r) {
      throw new Error(`Tenant cert_resolver "${tenantOverride}" is not defined in traefik.cert_resolvers`);
    }
    return { name: r.name, resolver: r };
  }

  // Longest pattern match wins on ties — prevents `*.example.com` from being shadowed by `*`.
  let best: { resolver: CertResolver; pattern: string } | null = null;
  for (const r of resolvers) {
    for (const pattern of r.domain_patterns ?? []) {
      if (!domainMatchesPattern(domain, pattern)) continue;
      if (!best || pattern.length > best.pattern.length) {
        best = { resolver: r, pattern };
      }
    }
  }
  if (best) return { name: best.resolver.name, resolver: best.resolver };

  const fallback = resolvers.find(r => r.challenge === 'http' && (!r.domain_patterns || r.domain_patterns.length === 0));
  if (fallback) return { name: fallback.name, resolver: fallback };

  throw new Error(
    `No cert resolver matches domain "${domain}". ` +
    `Define a resolver with matching domain_patterns, an explicit cert_resolver on the tenant, ` +
    `or an http-challenge resolver with no patterns to act as a fallback.`,
  );
}

/**
 * Resolve middleware references against the available scopes (global → app library).
 * Returns expanded specs in the same order as the input names. Throws on dangling refs.
 */
export function resolveMiddlewareChain(
  refs: string[],
  scopes: { global?: TraefikGlobal['middlewares']; app?: TraefikApp['middlewares'] } = {},
): Array<{ name: string; spec: MiddlewareSpec }> {
  return refs.map(name => {
    const spec = scopes.app?.[name] ?? scopes.global?.[name];
    if (!spec) {
      throw new Error(`Middleware "${name}" is not defined in app.traefik.middlewares or traefik.middlewares`);
    }
    return { name, spec };
  });
}

/** Allowed env var name pattern — prevents access to arbitrary process vars */
const SAFE_ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * Get a resolved configuration value, interpolating environment variables.
 * Supports ${ENV_VAR} and ${ENV_VAR:default} syntax.
 * Single-pass only — resolved values are NOT re-expanded.
 */
export function resolveEnvValue(template: string): string {
  return template.replace(/\$\{([^}:]+)(?::([^}]*))?\}/g, (match, envVar, defaultValue) => {
    if (!SAFE_ENV_NAME.test(envVar)) return match; // skip invalid var names
    return process.env[envVar] || defaultValue || '';
  });
}

/**
 * Load the raw YAML config without Zod parsing or defaults.
 * Useful for distinguishing explicitly set values from defaults.
 */
export function loadRawConfig(): Record<string, any> {
  const configPath = findConfigPath();
  return yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, any>;
}

/**
 * Clear the cached configuration (useful for testing)
 */
export function clearConfigCache(): void {
  cachedConfig = null;
}

/**
 * Get the container name prefix from config
 */
export function getContainerPrefix(): string {
  return loadConfig().project.prefix;
}

/**
 * Get the database name/user prefix from config
 */
export function getDatabasePrefix(): string {
  return loadConfig().project.db_prefix;
}

/**
 * Resolve the effective database prefix for an app.
 * When app.db_prefix is defined (including empty string), it overrides the project prefix.
 * When undefined or no app is passed, falls back to project.db_prefix.
 */
export function resolveAppDbPrefix(app?: Pick<AppDefinition, 'db_prefix'>): string {
  if (app && app.db_prefix !== undefined) {
    return app.db_prefix;
  }
  return loadConfig().project.db_prefix;
}

/**
 * Get the apps directory path from config.
 * This is the root directory containing app subdirectories.
 */
export function getAppsDir(): string {
  return loadConfig().networking?.apps_path || '/app/apps';
}

/**
 * Get the data directory path from config
 */
export function getDataDir(): string {
  const dir = loadConfig().data_dir || '/app/data';

  // If the path exists (inside container or custom path), use it
  if (fs.existsSync(dir)) return dir;

  // Fallback: derive from config file location (CLI running on host)
  // overwatch.yaml is at {deployDir}/overwatch/overwatch.yaml
  // data dir is at {deployDir}/overwatch/data/
  try {
    const configPath = findConfigPath();
    const overwatchDir = path.dirname(configPath);
    const hostDataDir = path.join(overwatchDir, 'data');
    if (fs.existsSync(hostDataDir)) return hostDataDir;
  } catch {}

  return dir;
}
