import * as fs from 'fs';
import * as path from 'path';
import { BlockList, isIP } from 'net';
import * as yaml from 'js-yaml';
import type { OverwatchConfig } from '../config/schema';
import type { AppDefinition } from '../models/app';
import type { Entrypoint, TraefikGlobal, TraefikTenant } from '../models/traefik';
import { listTenantDirsSync } from './tenantStore';
import { runDocker } from '../utils/runDocker';

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
  /**
   * The shared Docker network Traefik runs on and its gateway address(es), from
   * `resolveNetworkGateways`. Optional: without gateways the doctor still flags
   * loopback-only trust lists, but cannot name the address to trust or tell
   * whether a list covers it.
   */
  sharedNetwork?: { name: string; gateways: string[] };
}

/**
 * Pure validator for the resolved Traefik configuration. Returns a flat list of
 * issues — empty list means "everything resolves". Designed for tests: feed it
 * a hand-built context and assert on the result.
 */
export function validateTraefik(ctx: DoctorContext): DoctorIssue[] {
  const issues: DoctorIssue[] = [];
  const traefik = ctx.config.traefik;

  // Build the set of known middleware names per scope. A global middleware wins
  // over an app middleware of the same name (matches the runtime resolution order).
  const globalMws = new Set(Object.keys(traefik?.middlewares ?? {}));
  const appMws = new Map<string, Set<string>>();
  for (const app of ctx.apps) {
    appMws.set(app.id, new Set(Object.keys(app.traefik?.middlewares ?? {})));
    for (const name of appMws.get(app.id)!) {
      if (globalMws.has(name)) {
        issues.push({
          severity: 'warning',
          scope: `app:${app.id}.traefik.middlewares.${name}`,
          message: `Has the same name as a global middleware, which is used instead.`,
          hint: 'Rename the app middleware and the references to it.',
        });
      }
    }
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
    } else {
      const issue = checkSameHostProxyTrust(ep, ctx.sharedNetwork);
      if (issue) issues.push(issue);
    }
  }
  for (const ep of traefik?.entrypoints ?? []) {
    const issue = checkGatewayTrustOnPublicBind(ep, ctx.sharedNetwork);
    if (issue) issues.push(issue);
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

// ─── Forwarded-header trust behind a proxy on the same host ─────────────────

/**
 * Traefik runs on a Docker bridge network, so no peer ever reaches it from a
 * loopback address. A proxy on the same host that connects to the published
 * port (nginx → 127.0.0.1:8080) is delivered by Docker from the network's
 * gateway, e.g. 172.18.0.1. A trust list naming only loopback, or a
 * loopback-bound entrypoint whose list misses the gateway, never matches:
 * Traefik replaces X-Forwarded-* and every app sees the gateway as the client.
 *
 * Trusting the gateway is safe only on a loopback-bound entrypoint. On any
 * other bind, Docker also delivers connections from containers on other Docker
 * networks (NAT) and IPv6 clients (userland proxy) from the gateway address,
 * and those could forge X-Forwarded-For / X-Real-IP. So on such a bind the
 * advice is to bind to loopback first.
 */
function checkSameHostProxyTrust(ep: Entrypoint, net: DoctorContext['sharedNetwork']): DoctorIssue | null {
  const trusted = ep.forwarded_headers?.trusted_ips ?? [];
  const loopbackBind = isLoopbackBind(ep.host_bind);
  // On a public bind, the advice below moves the entrypoint to 127.0.0.1.
  const gateways = gatewaysForBind(loopbackBind ? ep.host_bind! : '127.0.0.1', net?.gateways ?? []);
  const loopbackOnly = trusted.length > 0 && trusted.every(isLoopbackRange);
  const gatewayMissed = loopbackBind && gateways.length > 0
    && !gateways.some(g => rangesInclude(trusted, g));
  if (!loopbackOnly && !gatewayMissed) return null;

  const gateway = `the ${net ? `"${net.name}" ` : ''}Docker network gateway${gateways.length > 0 ? ` (${gateways.join(', ')})` : ''}`;
  const message = loopbackOnly
    ? `trusted_ips lists only loopback addresses, which never match: a proxy on this host reaches Traefik from ${gateway}, not from 127.0.0.1. Traefik replaces X-Forwarded-* and apps see the gateway as every client's IP.`
    : `The entrypoint is published on ${ep.host_bind}, so every connection arrives from ${gateway}, which trusted_ips does not include. Traefik replaces X-Forwarded-* and apps see the gateway as every client's IP.`;
  const toAdd = gateways.length > 0
    ? gateways.map(g => `"${g}/${isIP(g) === 6 ? 128 : 32}"`).join(' and ')
    : `the gateway as a /32 (\`docker network inspect ${net?.name ?? '<network>'} --format '{{range .IPAM.Config}}{{.Gateway}} {{end}}'\`)`;
  const steps = `${toAdd} to forwarded_headers.trusted_ips, run \`overwatch infra deploy\`, then \`overwatch config traefik reload\`.`;
  return {
    severity: 'warning',
    scope: trustScope(ep),
    message,
    hint: loopbackBind
      ? `Add ${steps} Trust the gateway address only, not the network subnet: tenant containers connect from the subnet and could forge X-Forwarded-For.`
      : `First set \`host_bind: "127.0.0.1"\` on this entrypoint and point the proxy at 127.0.0.1:${ep.host_port ?? ep.port}; then add ${steps} ` +
        `Trusting the gateway is only safe on a loopback-bound entrypoint. While it is published on ${publishedOn(ep)}, Docker also delivers connections from containers on other Docker networks, and IPv6 clients through its userland proxy, from the gateway address, and they could forge X-Forwarded-For. ` +
        'If the proxy runs on another host, trust its address instead.',
  };
}

/**
 * A trust list that covers the shared network's gateway on an entrypoint not
 * bound to loopback: anything Docker delivers from the gateway (containers on
 * other Docker networks, IPv6 clients through the userland proxy) can set the
 * client IP apps see.
 */
function checkGatewayTrustOnPublicBind(ep: Entrypoint, net: DoctorContext['sharedNetwork']): DoctorIssue | null {
  const trusted = ep.forwarded_headers?.trusted_ips ?? [];
  if (!net || trusted.length === 0 || isLoopbackBind(ep.host_bind)) return null;
  const covered = net.gateways.filter(g => rangesInclude(trusted, g));
  if (covered.length === 0) return null;
  return {
    severity: 'warning',
    scope: trustScope(ep),
    message: `trusted_ips covers the "${net.name}" Docker network gateway (${covered.join(', ')}), but the entrypoint is published on ${publishedOn(ep)}. ` +
      'Docker delivers connections from containers on other Docker networks, and IPv6 clients through its userland proxy, from that address, so they can forge X-Forwarded-For and X-Real-IP.',
    hint: 'Set `host_bind: "127.0.0.1"` so only processes on this host reach the entrypoint, or remove the gateway (and any range covering it) from forwarded_headers.trusted_ips. Then run `overwatch infra deploy`.',
  };
}

function trustScope(ep: Entrypoint): string {
  return `traefik.entrypoints["${ep.name}"].forwarded_headers.trusted_ips`;
}

function publishedOn(ep: Entrypoint): string {
  return ep.host_bind ? ep.host_bind : 'all interfaces';
}

/**
 * The gateways a same-host proxy arrives from when it connects to `hostBind`:
 * those of the bind's address family, or all of them when the network has
 * none of that family (Docker's userland proxy then crosses families).
 */
function gatewaysForBind(hostBind: string, gateways: string[]): string[] {
  const family = isIP(bareHost(hostBind));
  const same = gateways.filter(g => isIP(g) === family);
  return same.length > 0 ? same : gateways;
}

function bareHost(hostBind: string): string {
  return hostBind.replace(/^\[|\]$/g, '');
}

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

/** An address or CIDR as Traefik's trustedIPs accepts it; null when malformed. */
function parseRange(range: string): { address: string; bits: number; type: 'ipv4' | 'ipv6' } | null {
  const [address, prefix, extra] = range.trim().split('/');
  const family = isIP(address);
  if (!family || extra !== undefined || (prefix !== undefined && !/^\d{1,3}$/.test(prefix))) return null;
  const max = family === 4 ? 32 : 128;
  const bits = prefix === undefined ? max : Number(prefix);
  return bits > max ? null : { address, bits, type: family === 4 ? 'ipv4' : 'ipv6' };
}

/** True when every address the range covers is a loopback address. */
function isLoopbackRange(range: string): boolean {
  const r = parseRange(range);
  return !!r && LOOPBACK.check(r.address, r.type) && r.bits >= (r.type === 'ipv4' ? 8 : 128);
}

function isLoopbackBind(hostBind: string | undefined): boolean {
  if (!hostBind) return false; // omitted = all interfaces
  const host = bareHost(hostBind);
  return host === 'localhost' || isLoopbackRange(host);
}

function rangesInclude(ranges: string[], ip: string): boolean {
  const target = parseRange(ip);
  if (!target) return false;
  const list = new BlockList();
  for (const range of ranges) {
    const r = parseRange(range);
    if (r) list.addSubnet(r.address, r.bits, r.type);
  }
  return list.check(target.address, target.type);
}

/**
 * True when a check uses the shared network's gateway, i.e. some entrypoint
 * trusts forwarded headers. Lets the CLI skip `docker network inspect` (up to
 * 15 s on a hung daemon) when there is nothing to check.
 */
export function needsNetworkGateways(config: OverwatchConfig): boolean {
  return (config.traefik?.entrypoints ?? []).some(ep => (ep.forwarded_headers?.trusted_ips.length ?? 0) > 0);
}

export interface NetworkGatewayLookup {
  gateways: string[];
  /** Why the network could not be inspected (no Docker, missing network, timeout). */
  error?: string;
}

/**
 * Gateway address(es) of a Docker network, as `docker network inspect` reports
 * them. Never throws: the doctor then falls back to its static checks, and the
 * caller reports `error` (or an empty list) as a skipped gateway check.
 */
export async function resolveNetworkGateways(network: string): Promise<NetworkGatewayLookup> {
  let stdout: string;
  try {
    ({ stdout } = await runDocker('docker', ['network', 'inspect', '--format', '{{json .IPAM.Config}}', network], { timeoutMs: 15_000 }));
  } catch (err) {
    return { gateways: [], error: (err instanceof Error ? err.message : String(err)).split('\n')[0] };
  }
  let config: unknown;
  try {
    config = JSON.parse(stdout.trim());
  } catch {
    return { gateways: [], error: 'unreadable `docker network inspect` output' };
  }
  if (!Array.isArray(config)) return { gateways: [] };
  return {
    gateways: config
      .map(c => (c as { Gateway?: unknown } | null)?.Gateway)
      .filter((g): g is string => typeof g === 'string' && isIP(g) !== 0),
  };
}

/**
 * Collect env var names visible to the deploy from all relevant sources:
 *   - process.env (the running shell)
 *   - <deployDir>/.env  (the dir containing overwatch.yaml)
 *   - <deployDir>/../<sibling>/.env  (sibling dirs at the project root, e.g.
 *     `infrastructure/.env` where Traefik provider tokens like CF_DNS_API_TOKEN
 *     typically live in the standard install layout)
 *
 * Falls back to just process.env when deployDir is undefined or no .env files
 * exist. Errors reading any individual file are swallowed silently.
 */
export function collectPresentEnvVars(deployDir?: string): Set<string> {
  const out = new Set<string>(Object.keys(process.env));
  if (!deployDir) return out;

  const candidates = new Set<string>();
  candidates.add(path.join(deployDir, '.env'));

  // Sibling .env files: scan the parent of deployDir for any `*/.env`. This
  // covers the typical layout where overwatch.yaml lives in `<root>/overwatch/`
  // alongside `<root>/infrastructure/.env`, etc.
  try {
    const parent = path.dirname(deployDir);
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      candidates.add(path.join(parent, entry.name, '.env'));
    }
  } catch {
    // parent unreadable — skip sibling scan
  }

  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    try {
      const text = fs.readFileSync(envPath, 'utf-8');
      for (const line of text.split('\n')) {
        const lineMatch = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=/);
        if (lineMatch) out.add(lineMatch[1]);
      }
    } catch {
      // ignore — individual env file unreadable
    }
  }
  return out;
}

/**
 * Walk apps/<id>/tenants/<id>/traefik.yaml across the deploy and return a
 * map appId → tenantId → overrides. Skips files that fail to parse.
 */
export function collectTenantOverrides(appsDir: string): Map<string, Map<string, TraefikTenant>> {
  const result = new Map<string, Map<string, TraefikTenant>>();
  for (const { appId, tenantId, dir } of listTenantDirsSync(appsDir, { followSymlinks: true })) {
    const yml = path.join(dir, 'traefik.yaml');
    if (!fs.existsSync(yml)) continue;
    try {
      const parsed = yaml.load(fs.readFileSync(yml, 'utf-8')) as TraefikTenant;
      if (parsed) {
        const inner = result.get(appId) ?? new Map<string, TraefikTenant>();
        inner.set(tenantId, parsed);
        result.set(appId, inner);
      }
    } catch {
      // ignore
    }
  }
  return result;
}
