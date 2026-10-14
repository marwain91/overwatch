import type { MiddlewareSpec, TraefikGlobal, TraefikApp, TraefikTenant } from '../models/traefik';
import { ValidationError } from '../utils/httpErrors';

// One set of masking rules for every read surface that can show Traefik
// credentials to non-admins (global config, app definitions, tenant overrides),
// plus the write-side counterpart that keeps the placeholder out of storage.

export const MASK = '••••••••';
// Raw-label keys whose value is an inline credential list.
const CREDENTIAL_LABEL_KEY = /\.(basicauth|digestauth)\.users$/i;
// Query parameters of an auth URL that carry credentials.
const SECRET_QUERY_PARAM = /(auth|credential|signature|sig|token|secret|key|password)/i;
const FORWARD_AUTH_LABEL = /\.forwardauth\.address$/i;

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
const USER_KEYED_MAP = /\.(customrequestheaders|customresponseheaders|sslproxyheaders|plugin)\./i;
const labelLeaf = (key: string) => (key.split('.').pop() ?? '').replace(/\[\d+\]$/, '').toLowerCase();

type Labels = Record<string, string>;

function maskUserEntry(entry: string): string {
  const colon = entry.indexOf(':');
  return colon < 0 ? MASK : `${entry.slice(0, colon)}:${MASK}`;
}
const isMaskedUserEntry = (entry: string) => entry === MASK || entry.endsWith(`:${MASK}`);
const userOf = (entry: string) => entry.slice(0, Math.max(entry.indexOf(':'), 0));
const maskUserList = (value: string) => value.split(',').map(e => maskUserEntry(e.trim())).join(',');

/** An auth URL without userinfo and with credential-looking query values masked. */
function redactAddress(address: string): string {
  try {
    const u = new URL(address);
    let changed = false;
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
      changed = true;
    }
    for (const name of [...new Set([...u.searchParams.keys()])]) {
      if (SECRET_QUERY_PARAM.test(name)) {
        u.searchParams.set(name, MASK);
        changed = true;
      }
    }
    return changed ? u.toString() : address;
  } catch {
    return MASK; // fail closed: an address that does not parse may still hold credentials
  }
}

const URL_IN_TEXT = /[a-z][a-z0-9+.\-]*:\/\/[^\s"'`<>]+/gi;
/**
 * Free text (regex, replacement, path, rule) that a non-admin may see: URL userinfo
 * becomes `scheme://••••••••@` and credential-looking query values are masked,
 * wherever a URL appears in the string.
 */
function redactUrlsInText(text: string): string {
  return text
    .replace(URL_IN_TEXT, url => url.replace(/^([a-z][a-z0-9+.\-]*:\/\/)[^/?#@\s]*@/i, `$1${MASK}@`))
    // Query values are masked anywhere (a path such as `/go?token=x` is not a full URL).
    .replace(/([?&;]([^=&#;\s]*)=)([^&#;\s]*)/g, (m, head: string, name: string) =>
      SECRET_QUERY_PARAM.test(name) ? `${head}${MASK}` : m);
}
// Typed middleware fields holding free text.
const TEXT_FIELDS = ['regex', 'replacement', 'path', 'expression'] as const;

/** Value of one raw label as a non-admin may see it. */
function redactLabelValue(key: string, value: string): string {
  if (CREDENTIAL_LABEL_KEY.test(key)) return maskUserList(value);
  if (FORWARD_AUTH_LABEL.test(key)) return redactAddress(value);
  if (USER_KEYED_MAP.test(key)) return MASK;
  return SAFE_LABEL_LEAVES.has(labelLeaf(key)) ? redactUrlsInText(value) : MASK;
}
const carriesMask = (v: string) => v.includes(MASK) || v.includes(encodeURIComponent(MASK));

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
    for (const f of TEXT_FIELDS) if (typeof mw[f] === 'string') mw[f] = redactUrlsInText(mw[f]);
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
    for (const f of TEXT_FIELDS) {
      if (typeof mw[f] !== 'string') continue;
      const kept = old?.type === mw.type ? old[f] : undefined;
      if (typeof kept === 'string' && mw[f] === redactUrlsInText(kept)) mw[f] = kept;
      else if (carriesMask(mw[f])) throw refuse(`${at}.${f}`);
    }
    if (mw.type === 'headers') {
      for (const field of ['custom_request_headers', 'custom_response_headers'] as const) {
        for (const [k, v] of Object.entries<string>(mw[field] ?? {})) {
          if (v !== MASK) continue;
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
