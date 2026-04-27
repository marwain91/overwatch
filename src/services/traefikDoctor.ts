import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { OverwatchConfig } from '../config/schema';
import type { AppDefinition } from '../models/app';
import type { Entrypoint, TraefikGlobal, TraefikTenant } from '../models/traefik';

export type IssueSeverity = 'error' | 'warning';

export interface DoctorIssue {
  severity: IssueSeverity;
  scope: string;          // e.g. "traefik.dashboard.middlewares" or "tenant:myapp/acme"
  message: string;
  hint?: string;
}

export interface DoctorContext {
  config: OverwatchConfig;
  apps: AppDefinition[];
  /** appId → tenantId → tenant traefik overrides (optional). */
  tenantOverrides: Map<string, Map<string, TraefikTenant>>;
  /** Names of env vars that are present in process.env or the deploy .env file. */
  presentEnvVars: Set<string>;
}

/**
 * Pure validator for the resolved Traefik configuration. Returns a flat list of
 * issues — empty list means "everything resolves". Designed for tests: feed it
 * a hand-built context and assert on the result.
 */
export function validateTraefik(ctx: DoctorContext): DoctorIssue[] {
  const issues: DoctorIssue[] = [];
  const traefik = ctx.config.traefik;

  // Build the set of known middleware names per scope. App-scoped middlewares
  // shadow global ones for that app (matches the runtime resolution order).
  const globalMws = new Set(Object.keys(traefik?.middlewares ?? {}));
  const appMws = new Map<string, Set<string>>();
  for (const app of ctx.apps) {
    appMws.set(app.id, new Set(Object.keys(app.traefik?.middlewares ?? {})));
  }
  const known = (appId: string | null, name: string): boolean => {
    if (appId && appMws.get(appId)?.has(name)) return true;
    return globalMws.has(name);
  };

  // ─── Cert resolvers ──────────────────────────────────────────────────────
  const resolverNames = new Set((traefik?.cert_resolvers ?? []).map(r => r.name));

  if (traefik?.cert_resolvers && traefik.cert_resolvers.length > 0) {
    const hasHttpFallback = traefik.cert_resolvers.some(
      r => r.challenge === 'http' && (!r.domain_patterns || r.domain_patterns.length === 0),
    );
    const hasUniversalPattern = traefik.cert_resolvers.some(
      r => r.domain_patterns?.includes('*'),
    );
    if (!hasHttpFallback && !hasUniversalPattern) {
      issues.push({
        severity: 'warning',
        scope: 'traefik.cert_resolvers',
        message: 'No fallback cert resolver: every tenant domain must match an explicit `domain_patterns` entry, or tenant-create will fail.',
        hint: 'Add a resolver with `challenge: http` and no `domain_patterns` (or one with `domain_patterns: ["*"]`).',
      });
    }
  }

  // Cert-resolver env vars must actually be present in the deploy environment,
  // and watch for placeholder values left over from the legacy shim.
  for (const r of traefik?.cert_resolvers ?? []) {
    if (r.challenge === 'dns' && r.env) {
      for (const [key, val] of Object.entries(r.env)) {
        // ${VAR} interpolation — only those need an env var set.
        const refMatch = val.match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/);
        if (!refMatch) continue;
        const referenced = refMatch[1];
        if (!ctx.presentEnvVars.has(referenced)) {
          issues.push({
            severity: 'error',
            scope: `traefik.cert_resolvers["${r.name}"].env.${key}`,
            message: `References env var \${${referenced}} which is not set in the deploy environment.`,
            hint: `Set ${referenced} in your deploy .env or unset the resolver's env entry.`,
          });
        }
      }
    }
    // Placeholders from the legacy shim — independent of env presence.
    const provider = r.challenge === 'dns' ? r.provider : null;
    if (provider === 'legacy' || r.acme_email === 'legacy@overwatch.local') {
      issues.push({
        severity: 'warning',
        scope: `traefik.cert_resolvers["${r.name}"]`,
        message: 'Resolver still has placeholder values from the legacy networking.cert_resolvers shim.',
        hint: 'Run `overwatch config traefik migrate` to populate real values.',
      });
    }
  }

  // ─── Entrypoints — trust list when termination=upstream ─────────────────
  const upstreamEpName = traefik?.upstream_entrypoint ?? 'web';
  if (effectiveGlobalTermination(traefik) === 'upstream') {
    const eps = traefik?.entrypoints ?? defaultEntrypoints();
    const ep = eps.find(e => e.name === upstreamEpName);
    if (!ep) {
      issues.push({
        severity: 'error',
        scope: `traefik.upstream_entrypoint`,
        message: `tls_termination=upstream selects entrypoint "${upstreamEpName}" but no such entrypoint is defined.`,
        hint: 'Add it to traefik.entrypoints or change traefik.upstream_entrypoint.',
      });
    } else if (!ep.forwarded_headers || ep.forwarded_headers.trusted_ips.length === 0) {
      issues.push({
        severity: 'warning',
        scope: `traefik.entrypoints["${ep.name}"].forwarded_headers`,
        message: 'tls_termination=upstream but the upstream entrypoint has no forwarded_headers.trusted_ips. Apps will see the upstream proxy IP, not the real client.',
        hint: 'Add CIDRs of upstream proxies (Cloudflare ranges, ALB subnet, nginx host) to forwarded_headers.trusted_ips.',
      });
    }
  }

  // ─── Dashboard, Overwatch, global default_middlewares ───────────────────
  for (const m of traefik?.default_middlewares ?? []) {
    if (!known(null, m)) {
      issues.push({
        severity: 'error',
        scope: 'traefik.default_middlewares',
        message: `References middleware "${m}" which is not defined under traefik.middlewares.`,
      });
    }
  }
  if (traefik?.dashboard?.cert_resolver && !resolverNames.has(traefik.dashboard.cert_resolver)) {
    issues.push({
      severity: 'error',
      scope: 'traefik.dashboard.cert_resolver',
      message: `References cert resolver "${traefik.dashboard.cert_resolver}" which is not defined.`,
    });
  }
  for (const m of traefik?.dashboard?.middlewares ?? []) {
    if (!known(null, m)) {
      issues.push({ severity: 'error', scope: 'traefik.dashboard.middlewares', message: `Middleware "${m}" not defined.` });
    }
  }
  if (traefik?.overwatch?.cert_resolver && !resolverNames.has(traefik.overwatch.cert_resolver)) {
    issues.push({
      severity: 'error',
      scope: 'traefik.overwatch.cert_resolver',
      message: `References cert resolver "${traefik.overwatch.cert_resolver}" which is not defined.`,
    });
  }
  for (const m of traefik?.overwatch?.middlewares ?? []) {
    if (!known(null, m)) {
      issues.push({ severity: 'error', scope: 'traefik.overwatch.middlewares', message: `Middleware "${m}" not defined.` });
    }
  }

  // ─── Per-app and per-service references ─────────────────────────────────
  for (const app of ctx.apps) {
    for (const m of app.traefik?.default_middlewares ?? []) {
      if (!known(app.id, m)) {
        issues.push({
          severity: 'error',
          scope: `app:${app.id}.traefik.default_middlewares`,
          message: `Middleware "${m}" not defined in app or global library.`,
        });
      }
    }
    for (const svc of app.services ?? []) {
      for (const m of svc.routing?.middlewares ?? []) {
        if (!known(app.id, m)) {
          issues.push({
            severity: 'error',
            scope: `app:${app.id}/service:${svc.name}.routing.middlewares`,
            message: `Middleware "${m}" not defined.`,
          });
        }
      }
    }
  }

  // ─── Per-tenant overrides ───────────────────────────────────────────────
  for (const [appId, tenants] of ctx.tenantOverrides) {
    for (const [tenantId, t] of tenants) {
      if (t.cert_resolver && !resolverNames.has(t.cert_resolver)) {
        issues.push({
          severity: 'error',
          scope: `tenant:${appId}/${tenantId}.cert_resolver`,
          message: `References cert resolver "${t.cert_resolver}" which is not defined.`,
        });
      }
      for (const [svcName, mws] of Object.entries(t.middleware_overrides ?? {})) {
        for (const m of mws) {
          if (!known(appId, m)) {
            issues.push({
              severity: 'error',
              scope: `tenant:${appId}/${tenantId}.middleware_overrides.${svcName}`,
              message: `Middleware "${m}" not defined.`,
            });
          }
        }
      }
    }
  }

  return issues;
}

function defaultEntrypoints(): Entrypoint[] {
  return [
    { name: 'web', port: 80, redirect_to: 'websecure' },
    { name: 'websecure', port: 443 },
  ];
}

function effectiveGlobalTermination(t: TraefikGlobal | undefined): 'traefik' | 'upstream' {
  return t?.tls_termination ?? 'traefik';
}

/** Read every key=value from the deploy `.env` next to overwatch.yaml plus process.env. */
export function collectPresentEnvVars(deployDir?: string): Set<string> {
  const out = new Set<string>(Object.keys(process.env));
  if (!deployDir) return out;
  const envPath = path.join(deployDir, '.env');
  if (!fs.existsSync(envPath)) return out;
  try {
    const text = fs.readFileSync(envPath, 'utf-8');
    for (const line of text.split('\n')) {
      const lineMatch = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=/);
      if (lineMatch) out.add(lineMatch[1]);
    }
  } catch {
    // ignore — env file is optional
  }
  return out;
}

/**
 * Walk apps/<id>/tenants/<id>/traefik.yaml across the deploy and return a
 * map appId → tenantId → overrides. Skips files that fail to parse.
 */
export function collectTenantOverrides(appsDir: string): Map<string, Map<string, TraefikTenant>> {
  const result = new Map<string, Map<string, TraefikTenant>>();
  if (!fs.existsSync(appsDir)) return result;
  for (const appId of fs.readdirSync(appsDir)) {
    const tenantsDir = path.join(appsDir, appId, 'tenants');
    if (!fs.existsSync(tenantsDir)) continue;
    const inner = new Map<string, TraefikTenant>();
    for (const tenantId of fs.readdirSync(tenantsDir)) {
      const yml = path.join(tenantsDir, tenantId, 'traefik.yaml');
      if (!fs.existsSync(yml)) continue;
      try {
        const parsed = yaml.load(fs.readFileSync(yml, 'utf-8')) as TraefikTenant;
        if (parsed) inner.set(tenantId, parsed);
      } catch {
        // ignore
      }
    }
    if (inner.size > 0) result.set(appId, inner);
  }
  return result;
}
