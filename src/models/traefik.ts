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
  /^traefik\.http\.routers\.[^.]+\.rule$/,
  /^traefik\.http\.routers\.[^.]+\.tls\.certresolver$/i,
  /^traefik\.http\.routers\.[^.]+\.entrypoints$/,
  /^traefik\.http\.routers\.[^.]+\.tls$/,
];

export function isDenylistedLabelKey(key: string): boolean {
  return RAW_LABEL_DENYLIST.some(rx => rx.test(key));
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

export const EntrypointSchema = z.object({
  name: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  redirect_to: z.string().optional().describe('Name of another entrypoint to redirect HTTP→HTTPS to'),
});

export type Entrypoint = z.infer<typeof EntrypointSchema>;

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
  middleware_overrides: z.record(z.array(z.string())).optional().describe('serviceName → middleware names. REPLACES the app\'s middleware list for that service.'),
  raw_labels: PerServiceRawLabelsSchema.optional().describe('serviceName → label key/value map (escape hatch, denylist enforced)'),
});

export type TraefikTenant = z.infer<typeof TraefikTenantSchema>;
