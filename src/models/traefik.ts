import { z } from 'zod';

// ─── Middleware specs (typed core) ──────────────────────────────────────────
// Discriminated union over the most-used Traefik middlewares. The long tail of
// less-common middlewares is reachable via `raw_labels` on services/tenants.

export const RateLimitMiddlewareSchema = z.object({
  type: z.literal('rateLimit'),
  average: z.number().int().nonnegative().describe('Sustained requests-per-period allowed'),
  burst: z.number().int().nonnegative().optional().describe('Maximum burst size above average'),
  period: z.string().optional().describe('Period for the average (e.g. "1s", "1m"). Defaults to 1s.'),
});

export const BasicAuthMiddlewareSchema = z.object({
  type: z.literal('basicAuth'),
  users: z.array(z.string().min(1)).min(1).describe('htpasswd-style user:hash entries (use bcrypt or md5_apr1)'),
  realm: z.string().optional().describe('HTTP Basic auth realm shown to clients'),
  remove_header: z.boolean().optional().describe('Remove the Authorization header before forwarding'),
});

export const ForwardAuthMiddlewareSchema = z.object({
  type: z.literal('forwardAuth'),
  address: z.string().url().describe('Auth service URL Traefik forwards the request to'),
  trust_forward_header: z.boolean().optional(),
  auth_response_headers: z.array(z.string()).optional().describe('Headers to copy from auth response back to the request'),
  auth_request_headers: z.array(z.string()).optional().describe('Headers to copy from the original request into the auth request'),
});

export const IpAllowListMiddlewareSchema = z.object({
  type: z.literal('ipAllowList'),
  source_range: z.array(z.string()).min(1).describe('CIDR ranges allowed to access the route'),
});

export const HeadersMiddlewareSchema = z.object({
  type: z.literal('headers'),
  custom_request_headers: z.record(z.string()).optional(),
  custom_response_headers: z.record(z.string()).optional(),
  sts_seconds: z.number().int().nonnegative().optional().describe('Strict-Transport-Security max-age'),
  sts_include_subdomains: z.boolean().optional(),
  sts_preload: z.boolean().optional(),
  force_sts_header: z.boolean().optional(),
  content_type_nosniff: z.boolean().optional(),
  frame_deny: z.boolean().optional(),
  custom_frame_options_value: z.string().optional(),
  browser_xss_filter: z.boolean().optional(),
  referrer_policy: z.string().optional(),
});

export const RedirectSchemeMiddlewareSchema = z.object({
  type: z.literal('redirectScheme'),
  scheme: z.enum(['http', 'https']),
  port: z.string().optional(),
  permanent: z.boolean().optional(),
});

export const RedirectRegexMiddlewareSchema = z.object({
  type: z.literal('redirectRegex'),
  regex: z.string().describe('Regex to match the request URL'),
  replacement: z.string().describe('Replacement URL (supports $1, $2 backreferences)'),
  permanent: z.boolean().optional(),
});

export const CompressMiddlewareSchema = z.object({
  type: z.literal('compress'),
  excluded_content_types: z.array(z.string()).optional(),
  min_response_body_bytes: z.number().int().nonnegative().optional(),
});

export const RetryMiddlewareSchema = z.object({
  type: z.literal('retry'),
  attempts: z.number().int().min(1).describe('Number of attempts'),
  initial_interval: z.string().optional().describe('First retry delay (e.g. "100ms")'),
});

export const CircuitBreakerMiddlewareSchema = z.object({
  type: z.literal('circuitBreaker'),
  expression: z.string().describe('Trip expression, e.g. "NetworkErrorRatio() > 0.5"'),
});

export const ReplacePathMiddlewareSchema = z.object({
  type: z.literal('replacePath'),
  path: z.string().describe('Replacement path'),
});

export const ReplacePathRegexMiddlewareSchema = z.object({
  type: z.literal('replacePathRegex'),
  regex: z.string(),
  replacement: z.string(),
});

export const InFlightReqMiddlewareSchema = z.object({
  type: z.literal('inFlightReq'),
  amount: z.number().int().min(1).describe('Maximum simultaneous in-flight requests'),
});

export const ChainMiddlewareSchema = z.object({
  type: z.literal('chain'),
  middlewares: z.array(z.string()).min(1).describe('Other middleware names to apply in order'),
});

export const MiddlewareSpecSchema = z.discriminatedUnion('type', [
  RateLimitMiddlewareSchema,
  BasicAuthMiddlewareSchema,
  ForwardAuthMiddlewareSchema,
  IpAllowListMiddlewareSchema,
  HeadersMiddlewareSchema,
  RedirectSchemeMiddlewareSchema,
  RedirectRegexMiddlewareSchema,
  CompressMiddlewareSchema,
  RetryMiddlewareSchema,
  CircuitBreakerMiddlewareSchema,
  ReplacePathMiddlewareSchema,
  ReplacePathRegexMiddlewareSchema,
  InFlightReqMiddlewareSchema,
  ChainMiddlewareSchema,
]);

export type MiddlewareSpec = z.infer<typeof MiddlewareSpecSchema>;
export const MIDDLEWARE_TYPES = [
  'rateLimit', 'basicAuth', 'forwardAuth', 'ipAllowList', 'headers',
  'redirectScheme', 'redirectRegex', 'compress', 'retry', 'circuitBreaker',
  'replacePath', 'replacePathRegex', 'inFlightReq', 'chain',
] as const;

// ─── Raw labels escape hatch (denylist enforced) ────────────────────────────
// These keys would let an app or tenant break multi-tenancy invariants:
//  - traefik.enable: only Overwatch toggles this (operator decision)
//  - routers.*.rule: Host() is computed by Overwatch from tenant.domain + host_aliases
//  - routers.*.tls.certresolver: managed via cert_resolver field
//  - routers.*.entrypoints / tls: managed by global config
const RAW_LABEL_DENYLIST: RegExp[] = [
  /^traefik\.enable$/,
  /^traefik\.http\.routers\.[^.]+\.rule(\[\d+\])?$/,
  /^traefik\.http\.routers\.[^.]+\.tls\.certresolver$/i,
  /^traefik\.http\.routers\.[^.]+\.entrypoints(\[\d+\])?$/,
  /^traefik\.http\.routers\.[^.]+\.tls$/,
];

export function isDenylistedLabelKey(key: string): boolean {
  return RAW_LABEL_DENYLIST.some(rx => rx.test(key));
}

// Every character a real Traefik label key uses (`[n]` indexes list fields).
const RAW_LABEL_KEY_RE = /^[A-Za-z0-9._\-[\]]+$/;

// Owned by Overwatch (container ownership, which monitoring trusts) and by
// compose itself; a raw label must not be able to restate them.
const RESERVED_RAW_LABEL_PREFIXES = ['com.overwatch.', 'com.docker.'];

/**
 * Which Traefik objects a raw label may address. Traefik objects share one
 * namespace per provider, so a label naming another tenant's router, service
 * or middleware would reconfigure that tenant. Names are compared lower-case,
 * as Traefik matches label keys case-insensitively.
 */
export interface RawLabelOwner {
  /** The router (and, by convention, service) names the labels may address. */
  isOwnRouter: (name: string) => boolean;
  isOwnMiddleware: (name: string) => boolean;
  /**
   * Middleware names the generator itself emits for this router (typed
   * `middlewares` fields); a raw router `middlewares` label may reference them.
   */
  isGeneratedMiddleware?: (name: string) => boolean;
  /** Operator-owned object (the Overwatch admin router): the tenant-facing field restrictions do not apply. */
  trusted?: boolean;
  /** Set for a tenant's own raw labels (editor-writable); app-level labels are admin-owned. */
  tenant?: TenantLabelScope;
}

/**
 * The global default_middlewares are the admin's: a tenant label may neither
 * leave them out of its router nor redefine them. Names are router-prefixed
 * and lower-case.
 */
export interface TenantLabelScope {
  /** Hosts the tenant routes (primary domain and aliases): the only hosts a redirect may target. */
  hosts: string[];
  /** The global default_middlewares of this router, which its `middlewares` list must keep. */
  requiredMiddlewares: string[];
  /** Those plus their chain members, which no label may redefine. */
  protectedMiddlewares: string[];
}

// Slugs may contain hyphens but never `_`, so a middleware named
// `<router>-<token>` with a hyphen-free token cannot belong to a different
// router whose name merely extends this one (tenant `t1-web-x` vs `t1`).
const MIDDLEWARE_SUFFIX_RE = /^[a-z0-9_]+$/;
function hasSingleTokenSuffix(name: string, prefix: string): boolean {
  return name.startsWith(prefix) && MIDDLEWARE_SUFFIX_RE.test(name.slice(prefix.length));
}

/** Owner of one concrete router `${appId}-${tenantId}-${service}`; its middlewares are prefixed with that name. */
export function rawLabelOwnerForRouter(routerName: string): RawLabelOwner {
  const own = routerName.toLowerCase();
  return {
    isOwnRouter: n => n === own,
    isOwnMiddleware: n => hasSingleTokenSuffix(n, `${own}-`),
  };
}

/**
 * Owner for app-level raw labels, which are rendered once per tenant: the
 * tenant is not known when the app is saved, so any `${appId}-<tenant>-${service}`
 * matches here. Generation re-checks against the concrete tenant.
 */
export function rawLabelOwnerForAppService(appId: string, service: string): RawLabelOwner {
  const head = `${appId.toLowerCase()}-`;
  const tail = `-${service.toLowerCase()}`;
  const ownRouter = (n: string) => n.length > head.length + tail.length && n.startsWith(head) && n.endsWith(tail);
  return {
    isOwnRouter: ownRouter,
    isOwnMiddleware: n => {
      if (!n.startsWith(head)) return false;
      const i = n.lastIndexOf('-');
      // `<app>-<tenant>-<service>-<token>`: strip the token, the rest must be a router name.
      return i > head.length && MIDDLEWARE_SUFFIX_RE.test(n.slice(i + 1)) && ownRouter(n.slice(0, i));
    },
    // Typed middleware names are `<router>-<name>` and the name may itself hold
    // hyphens (`rate-limit`). The app's middleware set is not known per tenant
    // here, so any suffix after an own router name passes; generation re-checks
    // against the exact generated names.
    isGeneratedMiddleware: n => {
      if (!n.startsWith(head)) return false;
      for (let i = n.indexOf('-', head.length); i !== -1; i = n.indexOf('-', i + 1)) {
        if (i < n.length - 1 && ownRouter(n.slice(0, i))) return true;
      }
      return false;
    },
  };
}

// Router fields Overwatch computes itself. `service` is checked separately
// (it may only name the router's own service); `tls.domains` would request
// certificates for hosts the tenant does not own.
const RESERVED_ROUTER_FIELDS = /^(rule|entrypoints|tls|tls\.certresolver|tls\.domains(\..*)?)$/;

// Middleware types a tenant may configure on its own middlewares. Allowlist:
// types that can name another service (errors, chain), fetch a URL
// (forwardauth), read a file or load code (plugin, *file fields) or reach a
// backend (ratelimit.redis) stay out, as does anything unknown or new.
const SAFE_MIDDLEWARE_TYPES = new Set([
  'headers', 'ratelimit', 'inflightreq', 'compress', 'retry', 'ipallowlist', 'ipwhitelist',
  'redirectscheme', 'redirectregex', 'stripprefix', 'stripprefixregex', 'addprefix',
  'replacepath', 'replacepathregex', 'buffering', 'contenttype', 'passtlsclientcert', 'grpcweb',
]);
const AUTH_MIDDLEWARE_FIELDS = /^(basicauth|digestauth)\.(users|realm|removeheader|headerfield)$/;

function middlewareFieldProblem(field: string): string | undefined {
  const type = field.split('.')[0];
  if (SAFE_MIDDLEWARE_TYPES.has(type)) {
    if (/^ratelimit\.redis(\.|$)/.test(field)) return 'ratelimit.redis would point Traefik at an arbitrary backend';
    return undefined;
  }
  // basicauth/digestauth: inline users only, never `usersfile`.
  if (AUTH_MIDDLEWARE_FIELDS.test(field)) return undefined;
  return `middleware type "${type}" is not allowed (it can reach other services, URLs or files)`;
}

/** Every entry of a router `middlewares` value must be an own or generated middleware (no @file/@internal/foreign). */
function routerMiddlewaresProblem(value: string, owner?: RawLabelOwner): string | undefined {
  if (!value.trim()) return undefined;
  for (const raw of value.split(',')) {
    const entry = raw.trim().toLowerCase();
    const m = /^([^@]+)(?:@docker)?$/.exec(entry);
    const name = m?.[1] ?? '';
    const ok = !!owner && !!name && (owner.isOwnMiddleware(name) || owner.isGeneratedMiddleware?.(name) === true);
    if (!ok) return `a router may only use its own middlewares (got "${raw.trim()}")`;
  }
  return undefined;
}

// Request headers that apps and auth proxies commonly take as the signed-in
// user's identity. `_` is compared as `-`: CGI-style backends (PHP) map both to
// the same HTTP_* variable.
const IDENTITY_REQUEST_HEADER = /^(authorization|proxy-authorization|cookie|x-forwarded-(user|email|groups|preferred-username|access-token)|remote-(user|email|groups|name)|x-(remote|auth|webauth|authenticated)-.+|x-user|x-email)$/;
const SECURITY_RESPONSE_HEADER = /^(content-security-policy|strict-transport-security|x-frame-options)$/;

/**
 * A redirect may stay on the tenant's own hosts only: Traefik answers non-GET
 * requests with 307/308, so browsers re-send a login form's POST body to the
 * target. Parsed as a browser parses a Location header.
 */
function redirectTargetProblem(value: string, hosts: string[]): string | undefined {
  const target = value.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
  if (/^\/(?![/\\])/.test(target)) return undefined;
  try {
    const url = new URL(target);
    const host = url.hostname.replace(/\.$/, '');
    if ((url.protocol === 'http:' || url.protocol === 'https:') && hosts.includes(host)) return undefined;
  } catch {
    // Neither a path nor an absolute URL.
  }
  return 'a redirect may only target a path (/...) or one of the tenant\'s own hosts';
}

function tenantLabelProblem(kind: string, name: string, field: string, value: string, scope: TenantLabelScope): string | undefined {
  if (kind === 'middlewares' && scope.protectedMiddlewares.includes(name)) {
    return `"${name}" is a global default middleware, which a tenant cannot change`;
  }
  if (kind === 'middlewares' && field === 'redirectregex.replacement') {
    return redirectTargetProblem(value, scope.hosts.map(h => h.toLowerCase().replace(/\.$/, '')));
  }
  const header = /^headers\.(customrequestheaders|customresponseheaders)\.(.+)$/.exec(field);
  if (kind === 'middlewares' && header) {
    const headerName = header[2].replace(/_/g, '-');
    if (header[1] === 'customrequestheaders' && IDENTITY_REQUEST_HEADER.test(headerName)) {
      return `request header "${header[2]}" carries the user's identity or credentials and cannot be set by a tenant`;
    }
    if (header[1] === 'customresponseheaders' && SECURITY_RESPONSE_HEADER.test(headerName) && value.trim() === '') {
      return `an empty value would remove the security response header "${header[2]}"`;
    }
  }
  if (kind === 'routers' && field === 'middlewares') {
    const listed = new Set(value.split(',').map(e => e.trim().toLowerCase().replace(/@docker$/, '')));
    const missing = scope.requiredMiddlewares.filter(n => !listed.has(n));
    if (missing.length > 0) return `the router's middlewares must keep the global default middlewares (missing ${missing.join(', ')})`;
  }
  return undefined;
}

/**
 * Why a raw label may not be emitted/stored, or undefined when it is fine.
 * Stricter than the schema check because the rules must see the key exactly as
 * compose and Traefik will:
 * - Only plain ASCII key characters pass. `=` would end the key early when
 *   compose splits "key=value" (`...rule=Host(x)#` becomes `...rule`);
 *   whitespace and non-ASCII letters differ between this check and Traefik,
 *   whose case-insensitive match (Go EqualFold) treats U+017F "ſ" as "s".
 * - With ASCII only, lower-casing matches Traefik's case-insensitive keys.
 * - Only `traefik.http.{routers,services,middlewares}.<name>.*` for names the
 *   `owner` owns; tcp/udp and every other `traefik.*` key is refused. Without an
 *   `owner` the name check is skipped (the reserved-field rules still apply).
 * - A tenant's own labels (`owner.tenant`) are also held to tenantLabelProblem.
 * Kept out of the schema refinement on purpose: that schema is parsed at
 * boot, so tightening it there would turn a stored key into a boot failure.
 */
export function rawLabelProblem(key: string, value: string, owner?: RawLabelOwner): string | undefined {
  if (!RAW_LABEL_KEY_RE.test(key)) {
    return 'key may only contain letters, digits and . _ - [ ]';
  }
  const lower = key.toLowerCase();
  if (RESERVED_RAW_LABEL_PREFIXES.some(p => lower.startsWith(p))) {
    return 'com.overwatch.* and com.docker.* labels are reserved';
  }
  if (isDenylistedLabelKey(lower)) return 'reserved by Overwatch (use the typed fields instead)';
  if (lower !== 'traefik' && !lower.startsWith('traefik.')) return undefined;

  const [, proto, kind, name, ...rest] = lower.split('.');
  if (proto === 'tcp' || proto === 'udp') return 'tcp/udp routing labels are not allowed';
  if (proto !== 'http' || !name || rest.length === 0 || !['routers', 'services', 'middlewares'].includes(kind)) {
    return 'only traefik.http.routers|services|middlewares.<own name>.* labels are allowed';
  }
  if (owner) {
    const own = kind === 'middlewares' ? owner.isOwnMiddleware(name) : owner.isOwnRouter(name);
    if (!own) return `"${name}" is not one of this tenant's own ${kind}`;
  }
  const field = rest.join('.').replace(/\[\d+\]/g, '');
  const trusted = owner?.trusted === true;
  if (owner?.tenant && !trusted) {
    const p = tenantLabelProblem(kind, name, field, value, owner.tenant);
    if (p) return p;
  }
  if (kind === 'middlewares' && !trusted) {
    const p = middlewareFieldProblem(field);
    if (p) return p;
  }
  if (kind === 'services') {
    // weighted/mirroring/failover can name any service (another tenant's
    // `<router>@docker`), a backend url points the host at any address, and
    // serverstransport can reference a foreign transport: allow only the plain
    // loadbalancer options.
    if (!field.startsWith('loadbalancer.')) {
      return 'only loadbalancer.* options are allowed on a service (weighted, mirroring and failover can reach other tenants\' services)';
    }
    if (/^loadbalancer\.servers?\.url$/.test(field)) {
      return 'a backend url would route the tenant host to an arbitrary address';
    }
    if (field === 'loadbalancer.serverstransport') return 'serverstransport may reference a transport owned by someone else';
  }
  if (kind === 'routers') {
    if (RESERVED_ROUTER_FIELDS.test(field)) return 'reserved by Overwatch (use the typed fields instead)';
    if (!trusted && /^tls(\.|$)/.test(field)) return 'tls options may reference a TLS option set owned by someone else';
    if (!trusted && field === 'middlewares') {
      const p = routerMiddlewaresProblem(value, owner);
      if (p) return p;
    }
    if (field === 'service') {
      const target = value.trim().toLowerCase().replace(/@docker$/, '');
      if (!owner || !owner.isOwnRouter(target)) return 'a router may only point at its own service';
    }
  }
  return undefined;
}

const CORS_LABEL = /^traefik\.http\.middlewares\.([^.]+)\.headers\.(accesscontrolallowcredentials|accesscontrolalloworiginlist|accesscontrolalloworiginlistregex)(\[\d+\])?$/;

/**
 * Labels of middlewares that combine accessControlAllowCredentials=true with a
 * `*`, `null` or regex origin: any site could then read responses made with
 * the user's cookies. The two settings are separate labels, so this looks at a
 * whole label set; returns key -> problem. Tenant labels only.
 */
export function credentialedAnyOriginProblems(labels: Record<string, string>): Map<string, string> {
  const byMiddleware = new Map<string, { keys: string[]; credentials: boolean; anyOrigin: boolean }>();
  for (const [key, value] of Object.entries(labels)) {
    const m = CORS_LABEL.exec(key.toLowerCase());
    if (!m) continue;
    const entry = byMiddleware.get(m[1]) ?? { keys: [], credentials: false, anyOrigin: false };
    entry.keys.push(key);
    // Go's ParseBool spellings of true.
    if (m[2] === 'accesscontrolallowcredentials') entry.credentials ||= /^(1|t|true)$/i.test(value.trim());
    // A regex cannot be shown to exclude foreign origins; with credentials, list them explicitly.
    else if (m[2] === 'accesscontrolalloworiginlistregex') entry.anyOrigin = true;
    else entry.anyOrigin ||= value.split(',').some(o => ['*', 'null'].includes(o.trim().toLowerCase()));
    byMiddleware.set(m[1], entry);
  }
  const out = new Map<string, string>();
  for (const e of byMiddleware.values()) {
    if (!e.credentials || !e.anyOrigin) continue;
    for (const k of e.keys) out.set(k, 'accessControlAllowCredentials=true needs an explicit origin list (no *, null or regex origin)');
  }
  return out;
}

export function isBlockedRawLabelKey(key: string, owner?: RawLabelOwner, value = ''): boolean {
  return rawLabelProblem(key, value, owner) !== undefined;
}

const denylistRefinement = (labels: Record<string, string>, ctx: z.RefinementCtx) => {
  for (const key of Object.keys(labels)) {
    if (isDenylistedLabelKey(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `Label key "${key}" is reserved by Overwatch and cannot be set via raw_labels. Use the corresponding typed field (cert_resolver, host_aliases, middlewares) or configure it at the global infrastructure level.`,
      });
    }
  }
};

export const RawLabelsSchema = z.record(z.string()).superRefine(denylistRefinement);
export const PerServiceRawLabelsSchema = z.record(RawLabelsSchema);

// ─── Cert resolvers ─────────────────────────────────────────────────────────

export const CertResolverDnsSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, 'Lowercase letters, digits, and dashes only'),
  challenge: z.literal('dns'),
  provider: z.string().min(1).describe('Traefik DNS provider name (cloudflare, gandi, route53, etc.)'),
  acme_email: z.string().describe('Contact email for Let\'s Encrypt registration'),
  ca_server: z.string().url().optional().describe('Override ACME directory URL (defaults to Let\'s Encrypt prod)'),
  env: z.record(z.string()).optional().describe('Provider-specific env vars passed to the Traefik container'),
  domain_patterns: z.array(z.string()).optional().describe('Domain glob patterns this resolver auto-matches'),
  resolvers: z.array(z.string()).optional().describe('Custom DNS-01 nameservers used during propagation checks'),
  delay_before_check: z.string().optional().describe('Delay before DNS propagation check (e.g. "30s")'),
});

export const CertResolverHttpSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, 'Lowercase letters, digits, and dashes only'),
  challenge: z.literal('http'),
  acme_email: z.string().describe('Contact email for Let\'s Encrypt registration'),
  ca_server: z.string().url().optional(),
  entrypoint: z.string().default('web').describe('Entrypoint name used for the HTTP-01 challenge'),
  domain_patterns: z.array(z.string()).optional(),
});

export const CertResolverSchema = z.discriminatedUnion('challenge', [
  CertResolverDnsSchema,
  CertResolverHttpSchema,
]);

export type CertResolver = z.infer<typeof CertResolverSchema>;

// ─── Entrypoints ────────────────────────────────────────────────────────────

// Trust configuration for upstream proxies. Required when Overwatch sits behind
// another reverse proxy that terminates TLS (Cloudflare, AWS ALB/NLB, an upstream
// nginx/HAProxy, another Traefik). Without these, Traefik strips X-Forwarded-*
// headers from untrusted senders and your apps see the upstream's IP instead of
// the real client.
export const ForwardedHeadersSchema = z.object({
  trusted_ips: z.array(z.string()).min(1).describe('CIDRs of upstream proxies whose X-Forwarded-* headers Traefik should trust'),
});

// PROXY protocol v1/v2 (HAProxy, AWS NLB). Like forwarded_headers but at the TCP
// layer — preserves real client IP without parsing HTTP headers.
export const ProxyProtocolSchema = z.object({
  trusted_ips: z.array(z.string()).min(1).describe('CIDRs of upstream proxies allowed to send PROXY protocol headers'),
});

export const EntrypointSchema = z.object({
  name: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  host_port: z.number().int().min(1).max(65535).optional().describe('Host-side published port (default: same as container `port`). Use to avoid clashing with another process on the host — e.g. an upstream nginx already owning 80/443.'),
  host_bind: z.string().optional().describe('Host-side bind address for the published port (default: "0.0.0.0", all interfaces). Set to "127.0.0.1" to expose Traefik only on loopback when an upstream proxy on the same host forwards to it.'),
  redirect_to: z.string().optional().describe('Name of another entrypoint to redirect HTTP→HTTPS to (omit when sitting behind an upstream HTTPS terminator)'),
  forwarded_headers: ForwardedHeadersSchema.optional().describe('Trust X-Forwarded-* headers from these upstream IPs'),
  proxy_protocol: ProxyProtocolSchema.optional().describe('Accept PROXY protocol from these upstream IPs'),
});

export type Entrypoint = z.infer<typeof EntrypointSchema>;

// TLS termination mode. `traefik` (default): Traefik terminates TLS and uses a
// cert resolver. `upstream`: an upstream proxy already terminates TLS — Traefik
// listens on the upstream entrypoint (default `web`) without TLS labels. Can be
// set globally, per-service (overrides global), and per-tenant (overrides both).
export const TlsTerminationSchema = z.enum(['traefik', 'upstream']);
export type TlsTermination = z.infer<typeof TlsTerminationSchema>;

// ─── Dashboard ──────────────────────────────────────────────────────────────

export const TraefikDashboardSchema = z.object({
  enabled: z.boolean().default(true),
  host: z.string().optional().describe('Hostname for the Traefik dashboard'),
  cert_resolver: z.string().optional().describe('Name of cert resolver to use for the dashboard host'),
  middlewares: z.array(z.string()).optional().describe('Middlewares applied to the dashboard router'),
  raw_labels: RawLabelsSchema.optional(),
});

// ─── Overwatch self-routing ─────────────────────────────────────────────────

export const TraefikOverwatchSchema = z.object({
  host: z.string().describe('Hostname for the Overwatch admin'),
  cert_resolver: z.string().optional(),
  middlewares: z.array(z.string()).optional(),
  raw_labels: RawLabelsSchema.optional(),
});

export type TraefikOverwatch = z.infer<typeof TraefikOverwatchSchema>;
export type TraefikDashboard = z.infer<typeof TraefikDashboardSchema>;

// ─── Global Traefik config (overwatch.yaml.traefik) ─────────────────────────

export const TraefikGlobalSchema = z.object({
  log_level: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']).default('INFO'),
  dashboard: TraefikDashboardSchema.optional(),
  entrypoints: z.array(EntrypointSchema).optional().describe('Custom entrypoints. Defaults to web (80) + websecure (443) when omitted.'),
  cert_resolvers: z.array(CertResolverSchema).optional().describe('Named TLS certificate resolvers'),
  middlewares: z.record(MiddlewareSpecSchema).optional().describe('Global middleware library, referenceable from any app/tenant/dashboard/overwatch router'),
  default_middlewares: z.array(z.string()).optional().describe('Middleware names applied to every generated router unless explicitly omitted'),
  overwatch: TraefikOverwatchSchema.optional().describe('Routing for the Overwatch admin server itself'),
  tls_termination: TlsTerminationSchema.optional().describe('Where TLS terminates. "traefik" (default): Traefik manages certs. "upstream": an upstream proxy terminates TLS; Traefik routes plain HTTP. Per-service and per-tenant overrides win.'),
  upstream_entrypoint: z.string().optional().describe('Name of the entrypoint Traefik listens on when behind an upstream SSL terminator (default: "web")'),
  allowed_alias_domains: z.array(z.string()).optional().describe('Domains (and their subdomains) tenants may use as host_aliases when the app\'s domain_template is a wildcard. Default: only hosts matching the template.'),
}).superRefine((cfg, ctx) => {
  // Cert resolver names must be unique within the list.
  if (cfg.cert_resolvers) {
    const seen = new Set<string>();
    cfg.cert_resolvers.forEach((r, i) => {
      if (seen.has(r.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cert_resolvers', i, 'name'],
          message: `Duplicate cert resolver name "${r.name}"`,
        });
      }
      seen.add(r.name);
    });
  }
  // Entrypoint names must be unique.
  if (cfg.entrypoints) {
    const seen = new Set<string>();
    cfg.entrypoints.forEach((e, i) => {
      if (seen.has(e.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['entrypoints', i, 'name'],
          message: `Duplicate entrypoint name "${e.name}"`,
        });
      }
      seen.add(e.name);
    });
  }
});

export type TraefikGlobal = z.infer<typeof TraefikGlobalSchema>;

// ─── Per-app Traefik config ─────────────────────────────────────────────────

export const TraefikAppSchema = z.object({
  middlewares: z.record(MiddlewareSpecSchema).optional().describe('App-scoped middleware library'),
  default_middlewares: z.array(z.string()).optional().describe('Applied to every service in this app'),
});

export type TraefikApp = z.infer<typeof TraefikAppSchema>;

// ─── Per-tenant Traefik config ──────────────────────────────────────────────

export const TraefikTenantSchema = z.object({
  cert_resolver: z.string().optional().describe('Explicit cert resolver name; overrides domain_pattern matching'),
  host_aliases: z.array(z.string()).optional().describe('Additional Host(...) matchers on the primary service'),
  middleware_overrides: z.record(z.array(z.string())).optional().describe('serviceName → middleware names. REPLACES the app- and service-level middlewares for that service; the global default_middlewares always apply.'),
  raw_labels: PerServiceRawLabelsSchema.optional().describe('serviceName → label key/value map (escape hatch, denylist enforced)'),
  tls_termination: TlsTerminationSchema.optional().describe('Override TLS termination mode for this tenant'),
});

export type TraefikTenant = z.infer<typeof TraefikTenantSchema>;
