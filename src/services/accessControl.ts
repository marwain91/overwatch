import type { AccessControl } from '../models/accessControl';

/** Build one predicate with first-match semantics, keeping the expression linear in policy size. */
export function accessAllowedExpression(policy: AccessControl): string {
  let allowed: string | boolean = policy.default_action === 'allow';
  for (const rule of [...policy.rules].reverse()) {
    const terms: string[] = [];
    // JSON string literals are valid Go quoted strings. Do not sanitize regexes:
    // stripping quotes/backslashes changes their meaning and can widen access.
    if (rule.path_regex !== undefined) terms.push(`PathRegexp(${JSON.stringify(rule.path_regex)})`);
    if (rule.source_ranges) terms.push(`(${rule.source_ranges.map(ip => `ClientIP(${JSON.stringify(ip)})`).join(' || ')})`);
    const match = `(${terms.join(' && ')})`;
    if (rule.action === 'allow') {
      if (allowed === true) continue;
      allowed = allowed === false ? match : `(${match} || ${allowed})`;
    } else {
      if (allowed === false) continue;
      allowed = allowed === true ? `!${match}` : `(!${match} && ${allowed})`;
    }
  }
  // ^ matches every request path, including an empty path.
  return typeof allowed === 'boolean' ? `${allowed ? '' : '!'}PathRegexp("^")` : allowed;
}

/**
 * Split a router into complementary allowed/denied routes. Both retain the
 * original routing priority, so adding a policy does not change which service
 * owns a path. A denied route answers 403 rather than falling through to a
 * less-specific service (e.g. a frontend catch-all behind an API router).
 */
export function applyAccessControl(labels: string[], router: string, baseRule: string, policy: AccessControl, configuredPriority?: number): string[] {
  const out = new Map(labels.map(label => {
    const at = label.indexOf('=');
    const key = label.slice(0, at);
    return [key.toLowerCase().startsWith('traefik.') ? key.toLowerCase() : key, label.slice(at + 1)];
  }));
  const prefix = `traefik.http.routers.${router}.`.toLowerCase();
  const denied = `${router}-_access_denied`.toLowerCase();
  const deniedPrefix = `traefik.http.routers.${denied}.`;
  const predicate = accessAllowedExpression(policy);
  // Traefik defaults to the rule's UTF-8 byte length, with priority=0 meaning
  // automatic. Pin it to the original rule before adding the policy predicate.
  const rawPriority = Number(out.get(`${prefix}priority`) ?? configuredPriority ?? 0);
  const priority = Number.isInteger(rawPriority) && rawPriority !== 0 ? rawPriority : Buffer.byteLength(baseRule);
  for (const [key, value] of [...out]) {
    if (key.startsWith(prefix) && !key.slice(prefix.length).startsWith('middlewares')) {
      out.set(`${deniedPrefix}${key.slice(prefix.length)}`, value);
    }
  }
  out.set(`${prefix}rule`, `(${baseRule}) && (${predicate})`);
  out.set(`${deniedPrefix}rule`, `(${baseRule}) && !(${predicate})`);
  for (const p of [prefix, deniedPrefix]) {
    out.set(`${p}priority`, String(priority));
    out.set(`${p}service`, router);
    out.set(`${p}rulesyntax`, 'v3');
  }
  // Traefik has no built-in deny middleware. Two disjoint allowlists in series
  // reject every address, including IPv6, with its standard 403 response.
  let gateIndex = 0;
  const gates = ['0.0.0.0/1', '128.0.0.0/1'].map(range => {
    // Typed middleware libraries predate the reserved raw-label namespace.
    // Pick unused names so even a legacy typed name cannot create a middleware
    // with two types and invalidate the deny route.
    let name: string;
    do { name = `${router}-_access_deny${gateIndex++}`.toLowerCase(); }
    while ([...out.keys()].some(key => key.startsWith(`traefik.http.middlewares.${name}.`)));
    out.set(`traefik.http.middlewares.${name}.ipallowlist.sourcerange`, range);
    return name;
  });
  const middlewares = out.get(`${prefix}middlewares`);
  out.set(`${deniedPrefix}middlewares`, [...gates, ...(middlewares ? [middlewares] : [])].join(','));
  return [...out].map(([key, value]) => `${key}=${value}`);
}
