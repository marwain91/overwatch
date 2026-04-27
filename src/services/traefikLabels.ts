import type { AppDefinition, AppService } from '../models/app';
import type { MiddlewareSpec, TraefikGlobal, TraefikTenant } from '../models/traefik';
import { isDenylistedLabelKey } from '../models/traefik';

/** Sanitize a value for safe embedding inside a Traefik backtick-delimited rule. */
export function sanitizeTraefikValue(value: string): string {
  return value.replace(/[`"\\]/g, '');
}

export interface BuildLabelsContext {
  app: AppDefinition;
  tenantId: string;
  domain: string;
  service: AppService;
  certResolverName: string;
  traefik?: TraefikGlobal;
  tenantOverrides?: TraefikTenant;
}

/**
 * Build the array of Traefik label lines for a single service. Each entry is
 * a fully formatted YAML array element ('      - "traefik.foo=bar"').
 *
 * Returns an empty array when the service shouldn't be exposed (init container
 * without ports, or routing.enabled=false).
 */
export function buildTraefikLabels(ctx: BuildLabelsContext): string[] {
  const { app, tenantId, domain, service, traefik, tenantOverrides, certResolverName } = ctx;

  if (service.is_init_container) return [];
  if (!service.ports?.internal) return [];
  if (service.routing?.enabled === false) return [];

  const routerName = `${app.id}-${tenantId}-${service.name}`;
  const labels: string[] = [];
  const push = (s: string) => labels.push(`      - "${s.replace(/"/g, '\\"')}"`);

  push('traefik.enable=true');

  // Host rule (with optional aliases) + path prefix
  const aliases = tenantOverrides?.host_aliases ?? [];
  const allHosts = [domain, ...aliases].map(h => sanitizeTraefikValue(h));
  let hostExpr = allHosts.length === 1
    ? `Host(\`${allHosts[0]}\`)`
    : `(${allHosts.map(h => `Host(\`${h}\`)`).join(' || ')})`;

  const pathPrefix = service.routing?.path_prefix;
  const additionalPrefixes = service.routing?.additional_path_prefixes ?? [];
  if (pathPrefix && additionalPrefixes.length > 0) {
    const all = [pathPrefix, ...additionalPrefixes];
    hostExpr += ` && (${all.map(p => `PathPrefix(\`${sanitizeTraefikValue(p)}\`)`).join(' || ')})`;
  } else if (pathPrefix) {
    hostExpr += ` && PathPrefix(\`${sanitizeTraefikValue(pathPrefix)}\`)`;
  }

  push(`traefik.http.routers.${routerName}.rule=${hostExpr}`);
  push(`traefik.http.routers.${routerName}.entrypoints=websecure`);
  push(`traefik.http.routers.${routerName}.tls=true`);
  push(`traefik.http.routers.${routerName}.tls.certresolver=${sanitizeTraefikValue(certResolverName)}`);

  if (service.routing?.priority !== undefined) {
    const p = Number(service.routing.priority);
    if (Number.isInteger(p)) push(`traefik.http.routers.${routerName}.priority=${p}`);
  }

  // Resolve which middlewares apply to this service:
  //   tenant.middleware_overrides[service] — REPLACES app's chain
  //   else: app.default_middlewares + service.routing.middlewares + global.default_middlewares
  // Plus an auto-emitted strip-prefix middleware when path_prefix + strip_prefix.
  const resolvedNames = resolveServiceMiddlewareNames(service, app, traefik, tenantOverrides);
  const expanded = new Map<string, MiddlewareSpec>();
  for (const name of resolvedNames) {
    const spec = lookupMiddleware(name, app, traefik);
    if (!spec) {
      throw new Error(
        `Middleware "${name}" referenced by ${app.id}/${tenantId}/${service.name} ` +
        `is not defined in app.traefik.middlewares or traefik.middlewares`,
      );
    }
    expandMiddleware(name, spec, app, traefik, expanded);
  }

  // Optional auto strip-prefix
  let stripPrefixName: string | null = null;
  if (pathPrefix && service.routing?.strip_prefix) {
    stripPrefixName = '_stripprefix';
    const all = additionalPrefixes.length > 0
      ? [pathPrefix, ...additionalPrefixes].map(p => sanitizeTraefikValue(p)).join(',')
      : sanitizeTraefikValue(pathPrefix);
    push(`traefik.http.middlewares.${routerName}-${stripPrefixName}.stripprefix.prefixes=${all}`);
  }

  // Emit middleware definitions
  for (const [name, spec] of expanded) {
    const mwId = `${routerName}-${name}`;
    for (const lbl of middlewareToLabels(mwId, spec, routerName)) {
      push(lbl);
    }
  }

  // Build router middleware reference list
  const routerMws: string[] = [];
  for (const name of resolvedNames) {
    routerMws.push(`${routerName}-${name}`);
  }
  if (stripPrefixName) {
    routerMws.push(`${routerName}-${stripPrefixName}`);
  }
  if (routerMws.length > 0) {
    push(`traefik.http.routers.${routerName}.middlewares=${routerMws.join(',')}`);
  }

  // Service load balancer port
  push(`traefik.http.services.${routerName}.loadbalancer.server.port=${service.ports.internal}`);

  // Raw labels (app-service + tenant-service), deny-filtered
  const merged = mergeRawLabels(
    service.routing?.raw_labels,
    tenantOverrides?.raw_labels?.[service.name],
  );
  for (const [k, v] of Object.entries(merged)) {
    if (isDenylistedLabelKey(k)) continue;
    push(`${k}=${v}`);
  }

  return labels;
}

function resolveServiceMiddlewareNames(
  service: AppService,
  app: AppDefinition,
  traefik: TraefikGlobal | undefined,
  tenantOverrides: TraefikTenant | undefined,
): string[] {
  const tenantOverride = tenantOverrides?.middleware_overrides?.[service.name];
  if (tenantOverride !== undefined) {
    return tenantOverride.slice();
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (n: string) => { if (!seen.has(n)) { seen.add(n); out.push(n); } };
  for (const n of traefik?.default_middlewares ?? []) add(n);
  for (const n of app.traefik?.default_middlewares ?? []) add(n);
  for (const n of service.routing?.middlewares ?? []) add(n);
  return out;
}

function lookupMiddleware(
  name: string,
  app: AppDefinition,
  traefik: TraefikGlobal | undefined,
): MiddlewareSpec | undefined {
  return app.traefik?.middlewares?.[name] ?? traefik?.middlewares?.[name];
}

/** Recursively expand a middleware (incl. chain references) into the unique set needed. */
function expandMiddleware(
  name: string,
  spec: MiddlewareSpec,
  app: AppDefinition,
  traefik: TraefikGlobal | undefined,
  out: Map<string, MiddlewareSpec>,
): void {
  if (out.has(name)) return;
  out.set(name, spec);
  if (spec.type === 'chain') {
    for (const ref of spec.middlewares) {
      const refSpec = lookupMiddleware(ref, app, traefik);
      if (!refSpec) {
        throw new Error(`Chain middleware "${name}" references unknown middleware "${ref}"`);
      }
      expandMiddleware(ref, refSpec, app, traefik, out);
    }
  }
}

function mergeRawLabels(...layers: Array<Record<string, string> | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) out[k] = v;
  }
  return out;
}

/**
 * Emit Traefik docker-provider labels for a single middleware spec.
 * `mwId` is the prefixed middleware name (e.g. `myapp-t1-web-rate-limit`).
 * `routerScope` is the router-name prefix used to scope chain references.
 */
function middlewareToLabels(mwId: string, spec: MiddlewareSpec, routerScope: string): string[] {
  const out: string[] = [];
  const base = `traefik.http.middlewares.${mwId}`;
  switch (spec.type) {
    case 'rateLimit':
      out.push(`${base}.ratelimit.average=${spec.average}`);
      if (spec.burst !== undefined) out.push(`${base}.ratelimit.burst=${spec.burst}`);
      if (spec.period) out.push(`${base}.ratelimit.period=${spec.period}`);
      break;
    case 'basicAuth':
      // Comma-separated; each entry is user:hash. Hash dollar signs are doubled by docker compose, handled at compose level via env if needed.
      out.push(`${base}.basicauth.users=${spec.users.join(',')}`);
      if (spec.realm) out.push(`${base}.basicauth.realm=${spec.realm}`);
      if (spec.remove_header) out.push(`${base}.basicauth.removeheader=true`);
      break;
    case 'forwardAuth':
      out.push(`${base}.forwardauth.address=${spec.address}`);
      if (spec.trust_forward_header) out.push(`${base}.forwardauth.trustforwardheader=true`);
      if (spec.auth_response_headers && spec.auth_response_headers.length > 0) {
        out.push(`${base}.forwardauth.authresponseheaders=${spec.auth_response_headers.join(',')}`);
      }
      if (spec.auth_request_headers && spec.auth_request_headers.length > 0) {
        out.push(`${base}.forwardauth.authrequestheaders=${spec.auth_request_headers.join(',')}`);
      }
      break;
    case 'ipAllowList':
      out.push(`${base}.ipallowlist.sourcerange=${spec.source_range.join(',')}`);
      break;
    case 'headers':
      if (spec.custom_request_headers) {
        for (const [k, v] of Object.entries(spec.custom_request_headers)) {
          out.push(`${base}.headers.customrequestheaders.${k}=${v}`);
        }
      }
      if (spec.custom_response_headers) {
        for (const [k, v] of Object.entries(spec.custom_response_headers)) {
          out.push(`${base}.headers.customresponseheaders.${k}=${v}`);
        }
      }
      if (spec.sts_seconds !== undefined) out.push(`${base}.headers.stsseconds=${spec.sts_seconds}`);
      if (spec.sts_include_subdomains) out.push(`${base}.headers.stsincludesubdomains=true`);
      if (spec.sts_preload) out.push(`${base}.headers.stspreload=true`);
      if (spec.force_sts_header) out.push(`${base}.headers.forcestsheader=true`);
      if (spec.content_type_nosniff) out.push(`${base}.headers.contenttypenosniff=true`);
      if (spec.frame_deny) out.push(`${base}.headers.framedeny=true`);
      if (spec.custom_frame_options_value) out.push(`${base}.headers.customframeoptionsvalue=${spec.custom_frame_options_value}`);
      if (spec.browser_xss_filter) out.push(`${base}.headers.browserxssfilter=true`);
      if (spec.referrer_policy) out.push(`${base}.headers.referrerpolicy=${spec.referrer_policy}`);
      break;
    case 'redirectScheme':
      out.push(`${base}.redirectscheme.scheme=${spec.scheme}`);
      if (spec.port) out.push(`${base}.redirectscheme.port=${spec.port}`);
      if (spec.permanent) out.push(`${base}.redirectscheme.permanent=true`);
      break;
    case 'redirectRegex':
      out.push(`${base}.redirectregex.regex=${spec.regex}`);
      out.push(`${base}.redirectregex.replacement=${spec.replacement}`);
      if (spec.permanent) out.push(`${base}.redirectregex.permanent=true`);
      break;
    case 'compress':
      out.push(`${base}.compress=true`);
      if (spec.excluded_content_types && spec.excluded_content_types.length > 0) {
        out.push(`${base}.compress.excludedcontenttypes=${spec.excluded_content_types.join(',')}`);
      }
      if (spec.min_response_body_bytes !== undefined) {
        out.push(`${base}.compress.minresponsebodybytes=${spec.min_response_body_bytes}`);
      }
      break;
    case 'retry':
      out.push(`${base}.retry.attempts=${spec.attempts}`);
      if (spec.initial_interval) out.push(`${base}.retry.initialinterval=${spec.initial_interval}`);
      break;
    case 'circuitBreaker':
      out.push(`${base}.circuitbreaker.expression=${spec.expression}`);
      break;
    case 'replacePath':
      out.push(`${base}.replacepath.path=${spec.path}`);
      break;
    case 'replacePathRegex':
      out.push(`${base}.replacepathregex.regex=${spec.regex}`);
      out.push(`${base}.replacepathregex.replacement=${spec.replacement}`);
      break;
    case 'inFlightReq':
      out.push(`${base}.inflightreq.amount=${spec.amount}`);
      break;
    case 'chain':
      // Chain references: rewrite each name with the router scope and @docker provider suffix.
      out.push(`${base}.chain.middlewares=${spec.middlewares.map(n => `${routerScope}-${n}@docker`).join(',')}`);
      break;
  }
  return out;
}
