import type { MiddlewareSpec, TraefikGlobal, TraefikApp, TraefikTenant } from '../models/traefik';
import { ValidationError } from '../utils/httpErrors';

// One set of masking rules for every read surface that can show Traefik
// credentials to non-admins (global config, app definitions, tenant overrides),
// plus the write-side counterpart that keeps the placeholder out of storage.

export const MASK = '••••••••';
// Raw-label keys whose value is an inline credential list.
const CREDENTIAL_LABEL_KEY = /\.(basicauth|digestauth)\.users$/i;
// Names of query/fragment/`;` parameters that carry credentials.
const SECRET_PARAM_IN_TEXT = /[?&#;]\s*[^=&#;\s]*(auth|credential|signature|sig|token|secret|key|pass|pwd|password|jwt|bearer|session|sid|otp|hmac|code)[^=&#;\s]*\s*=/i;
const ROUTER_REQUEST_MATCHER = /\b(Header|HeaderRegexp|Query|QueryRegexp)\s*\(/i;
// Only router references are shown in clear (names such as `auth@docker`); other `.middlewares`/`.service` keys (chain, errors) follow the normal rules.
const ROUTER_REFERENCE_KEY = /^traefik\.http\.routers\.[^.]+\.(middlewares|service)$/i;
const FORWARD_AUTH_LABEL = /\.forwardauth\.address$/i;

// Accepted limit: a secret embedded in plain path/regex text with no parameter name or `@` is undetectable, so such fields must not store secrets.
// Raw labels are masked fail-closed: a value is shown only when the label's last
// key segment is a known non-secret option. An unknown leaf (plugin settings,
// `forwardauth.tls.key`, anything a future Traefik adds) stays hidden.
const SAFE_LABEL_LEAVES = new Set([
  'enable', 'rule', 'entrypoints', 'priority', 'service', 'middlewares', 'tls', 'certresolver',
  'port', 'scheme', 'permanent', 'prefixes', 'prefix', 'regex', 'replacement', 'path',
  'average', 'burst', 'period', 'amount', 'depth', 'sourcerange', 'excludedips',
  'sslredirect', 'stsseconds', 'stsincludesubdomains', 'stspreload', 'forcestsheader',
  'framedeny', 'contenttypenosniff', 'browserxssfilter', 'referrerpolicy',
  'accesscontrolallowmethods', 'accesscontrolalloworiginlist', 'accesscontrolmaxage', 'addvaryheader',
  'attempts', 'initialinterval', 'maxrequestbodybytes', 'memrequestbodybytes', 'maxresponsebodybytes',
  'excludedcontenttypes', 'minresponsebodybytes', 'passhostheader', 'sticky', 'name',
  'secure', 'httponly', 'samesite', 'healthcheck', 'interval', 'timeout',
]);
// Map-valued options: the segment after the map name is user data (a header name,
// a plugin setting), so it can collide with an allowlisted leaf (`Cookie`, `Name`,
// `Path`). Every value under them is masked whatever the leaf is.
const USER_KEYED_MAP = /\.(customrequestheaders|customresponseheaders|sslproxyheaders|plugin|healthcheck\.headers)\./i;
const labelLeaf = (key: string) => (key.split('.').pop() ?? '').replace(/\[\d+\]$/, '').toLowerCase();

type Labels = Record<string, string>;

function maskUserEntry(entry: string): string {
  const colon = entry.indexOf(':');
  return colon < 0 ? MASK : `${entry.slice(0, colon)}:${MASK}`;
}
const isMaskedUserEntry = (entry: string) => entry === MASK || entry.endsWith(`:${MASK}`);
const userOf = (entry: string) => entry.slice(0, Math.max(entry.indexOf(':'), 0));
const maskUserList = (value: string) => value.split(',').map(e => maskUserEntry(e.trim())).join(',');

/** Best-effort percent-decoding (twice, for double-encoded values). */
function decoded(text: string): string {
  let out = text;
  for (let i = 0; i < 2; i++) {
    try { out = decodeURIComponent(out); } catch { break; }
  }
  return out;
}

/**
 * Whole-value fail-closed check for text a non-admin would otherwise see: anything
 * with an `@` (userinfo in any spelling) or a credential-named parameter in a
 * query, fragment or `;` segment is hidden entirely rather than rewritten.
 */
function visibleText(text: string): string {
  const d = decoded(text);
  return d.includes('@') || text.includes('@') || SECRET_PARAM_IN_TEXT.test(d) || SECRET_PARAM_IN_TEXT.test(text) ? MASK : text;
}

/**
 * An auth URL reduced to its origin; anything else it carried (userinfo, path,
 * `;` segment, query, fragment) can hold a credential in a form no pattern
 * reliably spots, so it is replaced by one placeholder segment. A non-http(s) or
 * unparsable address is hidden.
 */
function redactAddress(address: string): string {
  try {
    const u = new URL(address);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return MASK;
    const extra = !!(u.username || u.password) || (u.pathname !== '' && u.pathname !== '/') || u.search !== '' || u.hash !== '';
    return extra ? `${u.origin}/${MASK}` : `${u.origin}/`;
  } catch {
    return MASK; // fail closed: an address that does not parse may still hold credentials
  }
}

/** Value of one raw label as a non-admin may see it. */
function redactLabelValue(key: string, value: string): string {
  if (CREDENTIAL_LABEL_KEY.test(key)) return maskUserList(value);
  if (FORWARD_AUTH_LABEL.test(key)) return redactAddress(value);
  if (USER_KEYED_MAP.test(key)) return MASK;
  const leaf = labelLeaf(key);
  if (!SAFE_LABEL_LEAVES.has(leaf)) return MASK;
  // A request-matching rule (header/query value) can embed a secret.
  if (leaf === 'rule' && ROUTER_REQUEST_MATCHER.test(value)) return MASK;
  // References such as `auth@docker,rate@file` are names, not URLs.
  if (ROUTER_REFERENCE_KEY.test(key)) return value;
  return visibleText(value);
}
const carriesMask = (v: string) => v.includes(MASK) || v.includes(encodeURIComponent(MASK));

/** Mask every string field of a typed middleware that looks sensitive (booleans/numbers stay). */
function redactTypedText(mw: Record<string, any>, skip: string[]): void {
  const walk = (v: any): any => typeof v === 'string' ? visibleText(v) : Array.isArray(v) ? v.map(walk) : v;
  for (const k of Object.keys(mw)) if (!skip.includes(k)) mw[k] = walk(mw[k]);
}

function restoreTypedText(mw: Record<string, any>, old: Record<string, any> | undefined, skip: string[], at: string): void {
  const walk = (inc: any, prev: any, where: string): any => {
    if (typeof inc === 'string') {
      if (typeof prev === 'string' && inc === visibleText(prev)) return prev;
      if (carriesMask(inc)) throw refuse(where);
      return inc;
    }
    if (Array.isArray(inc)) return inc.map((x, i) => walk(x, Array.isArray(prev) ? prev[i] : undefined, `${where}[${i}]`));
    return inc;
  };
  for (const k of Object.keys(mw)) if (!skip.includes(k)) mw[k] = walk(mw[k], old?.[k], `${at}.${k}`);
}

// ─── Read side ──────────────────────────────────────────────────────────────

/** Copy with htpasswd/digest hashes, forwardAuth URL credentials and secret-looking header values masked. */
export function redactMiddlewareCredentials(
  middlewares: Record<string, MiddlewareSpec> | undefined,
): Record<string, MiddlewareSpec> | undefined {
  if (!middlewares) return middlewares;
  const copy: Record<string, any> = JSON.parse(JSON.stringify(middlewares));
  for (const mw of Object.values(copy)) {
    if (mw.type === 'basicAuth' && Array.isArray(mw.users)) mw.users = mw.users.map(maskUserEntry);
    if (mw.type === 'forwardAuth' && typeof mw.address === 'string') mw.address = redactAddress(mw.address);
    if (mw.type === 'headers') {
      for (const bag of [mw.custom_request_headers, mw.custom_response_headers]) {
        // Fail closed: a header name says little about its value (`X-Session-Id`).
        for (const k of Object.keys(bag ?? {})) bag[k] = MASK;
      }
    }
    redactTypedText(mw, ['type', 'address', 'users', 'custom_request_headers', 'custom_response_headers']);
  }
  return copy;
}

/** Copy of a raw-label map with `basicauth|digestauth.users` values masked. */
export function redactRawLabels<T extends Labels | undefined>(labels: T): T {
  if (!labels) return labels;
  const copy: Labels = { ...labels };
  for (const [k, v] of Object.entries(copy)) copy[k] = redactLabelValue(k, v);
  return copy as T;
}

/** Dashboard / Overwatch routing block (raw labels can define auth users). */
export function redactRoutingCredentials<T extends { raw_labels?: Labels } | undefined>(block: T): T {
  if (!block?.raw_labels) return block;
  return { ...block, raw_labels: redactRawLabels(block.raw_labels) };
}

export function redactTraefikCredentials(t: TraefikGlobal | undefined): TraefikGlobal | undefined {
  if (!t) return t;
  return {
    ...t,
    ...(t.middlewares ? { middlewares: redactMiddlewareCredentials(t.middlewares) } : {}),
    ...(t.overwatch ? { overwatch: redactRoutingCredentials(t.overwatch) } : {}),
    ...(t.dashboard ? { dashboard: redactRoutingCredentials(t.dashboard) } : {}),
  };
}

export function redactAppTraefik(t: TraefikApp | undefined): TraefikApp | undefined {
  if (!t?.middlewares) return t;
  return { ...t, middlewares: redactMiddlewareCredentials(t.middlewares) };
}

/** An app definition: its Traefik library and every service's raw labels. */
export function redactAppDefinition<T extends { traefik?: TraefikApp; services?: any[] }>(app: T): T {
  const out: any = { ...app };
  if (app.traefik) out.traefik = redactAppTraefik(app.traefik);
  if (Array.isArray(app.services)) {
    out.services = app.services.map(svc =>
      svc?.routing?.raw_labels ? { ...svc, routing: { ...svc.routing, raw_labels: redactRawLabels(svc.routing.raw_labels) } } : svc);
  }
  return out;
}

/** Tenant overrides: per-service raw labels (middleware_overrides only hold names). */
export function redactTenantTraefik(t: TraefikTenant | undefined): TraefikTenant | undefined {
  if (!t?.raw_labels) return t;
  return {
    ...t,
    raw_labels: Object.fromEntries(Object.entries(t.raw_labels).map(([svc, labels]) => [svc, redactRawLabels(labels)])),
  };
}

// ─── Write side ─────────────────────────────────────────────────────────────
// A non-admin that reads a masked config and saves it back sends the placeholder.
// It is replaced by the stored value for the same middleware/user/header, and a
// placeholder with nothing to restore is refused, so it is never persisted.

const refuse = (what: string) => new ValidationError(`${what} contains a masked placeholder with no stored value to keep; re-enter the credential`);

function restoreUsers(incoming: string[], stored: string[] | undefined, where: string): string[] {
  return incoming.map(entry => {
    if (!isMaskedUserEntry(entry)) return entry;
    const kept = stored?.find(s => userOf(s) === userOf(entry) && !isMaskedUserEntry(s));
    if (!kept) throw refuse(where);
    return kept;
  });
}

export function restoreMiddlewareCredentials<T extends Record<string, MiddlewareSpec> | undefined>(
  incoming: T,
  stored: Record<string, MiddlewareSpec> | undefined,
  where = 'middlewares',
): T {
  if (!incoming) return incoming;
  const out: Record<string, any> = JSON.parse(JSON.stringify(incoming));
  for (const [name, mw] of Object.entries(out)) {
    const old: any = stored?.[name];
    const at = `${where}.${name}`;
    if (mw.type === 'basicAuth' && Array.isArray(mw.users)) {
      mw.users = restoreUsers(mw.users, old?.type === 'basicAuth' ? old.users : undefined, at);
    }
    if (mw.type === 'forwardAuth' && typeof mw.address === 'string') {
      if (old?.type === 'forwardAuth' && mw.address === redactAddress(old.address)) mw.address = old.address;
      else if (carriesMask(mw.address)) throw refuse(`${at}.address`);
    }
    restoreTypedText(mw, old?.type === mw.type ? old : undefined, ['type', 'address', 'users', 'custom_request_headers', 'custom_response_headers'], at);
    if (mw.type === 'headers') {
      for (const field of ['custom_request_headers', 'custom_response_headers'] as const) {
        for (const [k, v] of Object.entries<string>(mw[field] ?? {})) {
          if (v !== MASK) {
            if (carriesMask(v)) throw refuse(`${at}.${field}.${k}`);
            continue;
          }
          const kept = old?.type === 'headers' ? old[field]?.[k] : undefined;
          if (kept === undefined || kept === MASK) throw refuse(`${at}.${field}.${k}`);
          mw[field][k] = kept;
        }
      }
    }
  }
  return out as T;
}

export function restoreRawLabels<T extends Labels | undefined>(incoming: T, stored: Labels | undefined, where = 'raw_labels'): T {
  if (!incoming) return incoming;
  const out: Labels = { ...incoming };
  for (const [k, v] of Object.entries(out)) {
    if (CREDENTIAL_LABEL_KEY.test(k)) {
      if (!v.split(',').some(e => isMaskedUserEntry(e.trim()))) continue;
      const storedEntries = (stored?.[k] ?? '').split(',').map(e => e.trim());
      out[k] = v.split(',').map(e => restoreUsers([e.trim()], storedEntries, `${where}.${k}`)[0]).join(',');
      continue;
    }
    // Exact key: the placeholder stands for the value stored under this same key.
    const keep = stored?.[k];
    if (keep !== undefined && redactLabelValue(k, keep) === v) out[k] = keep;
    else if (carriesMask(v)) throw refuse(`${where}.${k}`);
  }
  return out as T;
}

export function restoreRoutingCredentials<T extends { raw_labels?: Labels } | undefined>(incoming: T, stored: { raw_labels?: Labels } | undefined): T {
  if (!incoming?.raw_labels) return incoming;
  return { ...incoming, raw_labels: restoreRawLabels(incoming.raw_labels, stored?.raw_labels) };
}

export function restoreTenantTraefik<T extends TraefikTenant>(incoming: T, stored: TraefikTenant | undefined): T {
  if (!incoming.raw_labels) return incoming;
  return {
    ...incoming,
    raw_labels: Object.fromEntries(Object.entries(incoming.raw_labels).map(
      ([svc, labels]) => [svc, restoreRawLabels(labels, stored?.raw_labels?.[svc], `raw_labels.${svc}`)])),
  };
}

/** Refuse (no stored value to fall back on) any placeholder in an app definition. */
export function assertNoMaskedCredentials(app: { traefik?: TraefikApp; services?: any[] }): void {
  restoreMiddlewareCredentials(app.traefik?.middlewares, undefined, 'traefik.middlewares');
  for (const svc of app.services ?? []) {
    restoreRawLabels(svc?.routing?.raw_labels, undefined, `services.${svc?.name}.routing.raw_labels`);
  }
}
