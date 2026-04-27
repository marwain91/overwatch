import * as yaml from 'js-yaml';
import type { OverwatchConfig } from '../config/schema';
import type { CertResolver, MiddlewareSpec, TraefikGlobal } from '../models/traefik';

/**
 * Build the Traefik static configuration (traefik.yml) from the new
 * `traefik` schema. Equivalent to the legacy hand-rolled template but
 * driven entirely by overwatch.yaml.
 */
export function buildTraefikStaticYml(traefik: TraefikGlobal): string {
  const entrypoints = traefik.entrypoints ?? [
    { name: 'web', port: 80, redirect_to: 'websecure' },
    { name: 'websecure', port: 443 },
  ];
  const entryPointsObj: Record<string, any> = {};
  for (const ep of entrypoints) {
    const eobj: any = { address: `:${ep.port}` };
    if (ep.redirect_to) {
      eobj.http = {
        redirections: {
          entryPoint: { to: ep.redirect_to, scheme: 'https', permanent: true },
        },
      };
    }
    if (ep.name === 'websecure' && (traefik.default_middlewares?.length ?? 0) > 0) {
      eobj.http = eobj.http || {};
      eobj.http.middlewares = traefik.default_middlewares!.map(m => `${m}@file`);
    }
    entryPointsObj[ep.name] = eobj;
  }

  const certificatesResolvers: Record<string, any> = {};
  for (const r of traefik.cert_resolvers ?? []) {
    certificatesResolvers[r.name] = certResolverToTraefik(r);
  }

  const out: any = {
    api: { dashboard: !!traefik.dashboard?.enabled, insecure: false },
    entryPoints: entryPointsObj,
    certificatesResolvers,
    providers: {
      docker: {
        endpoint: 'unix:///var/run/docker.sock',
        exposedByDefault: false,
        network: '${NETWORK_NAME}',
      },
      file: { filename: '/etc/traefik/dynamic.yml' },
    },
    log: { level: traefik.log_level ?? 'INFO', format: 'common' },
    accessLog: { filePath: '/var/log/traefik/access.log', bufferingSize: 100 },
  };

  return yamlHeader('Traefik static configuration. Generated from overwatch.yaml.traefik.') +
    yaml.dump(out, { lineWidth: 120, noRefs: true });
}

function certResolverToTraefik(r: CertResolver): any {
  const acme: any = { storage: '/letsencrypt/acme.json', email: r.acme_email };
  if (r.ca_server) acme.caServer = r.ca_server;
  if (r.challenge === 'dns') {
    const dns: any = { provider: r.provider };
    if (r.resolvers && r.resolvers.length > 0) dns.resolvers = r.resolvers;
    if (r.delay_before_check) dns.delayBeforeCheck = r.delay_before_check;
    acme.dnsChallenge = dns;
  } else {
    acme.httpChallenge = { entryPoint: r.entrypoint ?? 'web' };
  }
  return { acme };
}

/**
 * Build the Traefik dynamic configuration (dynamic.yml) — middleware library +
 * dashboard router. Replaces both the legacy `dynamic.yml` (HSTS only) and
 * `dynamic/dashboard.yml` files.
 */
export function buildTraefikDynamicYml(traefik: TraefikGlobal): string {
  const out: any = { http: {} };

  // Middleware library
  if (traefik.middlewares && Object.keys(traefik.middlewares).length > 0) {
    out.http.middlewares = {};
    for (const [name, spec] of Object.entries(traefik.middlewares)) {
      out.http.middlewares[name] = middlewareSpecToFileProvider(spec);
    }
  }

  // Dashboard router
  if (traefik.dashboard?.enabled && traefik.dashboard.host) {
    out.http.routers = out.http.routers ?? {};
    out.http.routers.dashboard = {
      rule: `Host(\`${traefik.dashboard.host}\`)`,
      service: 'api@internal',
      entryPoints: ['websecure'],
      tls: traefik.dashboard.cert_resolver
        ? { certResolver: traefik.dashboard.cert_resolver }
        : true,
    };
    if (traefik.dashboard.middlewares && traefik.dashboard.middlewares.length > 0) {
      out.http.routers.dashboard.middlewares = traefik.dashboard.middlewares.map(m => `${m}@file`);
    }
  }

  if (!out.http.middlewares && !out.http.routers) {
    return yamlHeader('Traefik dynamic configuration. Generated from overwatch.yaml.traefik.\n# (No middlewares or dashboard configured.)') + 'http: {}\n';
  }

  return yamlHeader('Traefik dynamic configuration. Generated from overwatch.yaml.traefik.') +
    yaml.dump(out, { lineWidth: 120, noRefs: true });
}

/**
 * Convert a typed MiddlewareSpec into Traefik file-provider YAML structure.
 * Mirrors `middlewareToLabels` in traefikLabels.ts but emits camelCase tree.
 */
function middlewareSpecToFileProvider(spec: MiddlewareSpec): any {
  switch (spec.type) {
    case 'rateLimit': {
      const o: any = { average: spec.average };
      if (spec.burst !== undefined) o.burst = spec.burst;
      if (spec.period) o.period = spec.period;
      return { rateLimit: o };
    }
    case 'basicAuth': {
      const o: any = { users: spec.users };
      if (spec.realm) o.realm = spec.realm;
      if (spec.remove_header) o.removeHeader = true;
      return { basicAuth: o };
    }
    case 'forwardAuth': {
      const o: any = { address: spec.address };
      if (spec.trust_forward_header) o.trustForwardHeader = true;
      if (spec.auth_response_headers && spec.auth_response_headers.length > 0) o.authResponseHeaders = spec.auth_response_headers;
      if (spec.auth_request_headers && spec.auth_request_headers.length > 0) o.authRequestHeaders = spec.auth_request_headers;
      return { forwardAuth: o };
    }
    case 'ipAllowList':
      return { ipAllowList: { sourceRange: spec.source_range } };
    case 'headers': {
      const o: any = {};
      if (spec.custom_request_headers) o.customRequestHeaders = spec.custom_request_headers;
      if (spec.custom_response_headers) o.customResponseHeaders = spec.custom_response_headers;
      if (spec.sts_seconds !== undefined) o.stsSeconds = spec.sts_seconds;
      if (spec.sts_include_subdomains) o.stsIncludeSubdomains = true;
      if (spec.sts_preload) o.stsPreload = true;
      if (spec.force_sts_header) o.forceSTSHeader = true;
      if (spec.content_type_nosniff) o.contentTypeNosniff = true;
      if (spec.frame_deny) o.frameDeny = true;
      if (spec.custom_frame_options_value) o.customFrameOptionsValue = spec.custom_frame_options_value;
      if (spec.browser_xss_filter) o.browserXssFilter = true;
      if (spec.referrer_policy) o.referrerPolicy = spec.referrer_policy;
      return { headers: o };
    }
    case 'redirectScheme': {
      const o: any = { scheme: spec.scheme };
      if (spec.port) o.port = spec.port;
      if (spec.permanent) o.permanent = true;
      return { redirectScheme: o };
    }
    case 'redirectRegex': {
      const o: any = { regex: spec.regex, replacement: spec.replacement };
      if (spec.permanent) o.permanent = true;
      return { redirectRegex: o };
    }
    case 'compress': {
      const o: any = {};
      if (spec.excluded_content_types && spec.excluded_content_types.length > 0) o.excludedContentTypes = spec.excluded_content_types;
      if (spec.min_response_body_bytes !== undefined) o.minResponseBodyBytes = spec.min_response_body_bytes;
      return { compress: o };
    }
    case 'retry': {
      const o: any = { attempts: spec.attempts };
      if (spec.initial_interval) o.initialInterval = spec.initial_interval;
      return { retry: o };
    }
    case 'circuitBreaker':
      return { circuitBreaker: { expression: spec.expression } };
    case 'replacePath':
      return { replacePath: { path: spec.path } };
    case 'replacePathRegex':
      return { replacePathRegex: { regex: spec.regex, replacement: spec.replacement } };
    case 'inFlightReq':
      return { inFlightReq: { amount: spec.amount } };
    case 'chain':
      return { chain: { middlewares: spec.middlewares.map(m => `${m}@file`) } };
  }
}

function yamlHeader(comment: string): string {
  return `# ${comment.replace(/\n/g, '\n# ')}\n# Edits will be overwritten by \`overwatch infra deploy\`.\n\n`;
}

/**
 * Whether the new generators should run. False for legacy installs that
 * haven't migrated to traefik.cert_resolvers — those keep their hand-rolled
 * templates.
 */
export function shouldUseDynamicTraefik(config: OverwatchConfig): boolean {
  return !!(config.traefik?.cert_resolvers && config.traefik.cert_resolvers.length > 0);
}
