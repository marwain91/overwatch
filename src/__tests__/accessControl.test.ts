import { BlockList, isIP } from 'node:net';
import { RE2JS } from 're2js';
import { describe, expect, it, vi } from 'vitest';
import { AccessControlSchema, type AccessControl } from '../models/accessControl';
import { TraefikAppSchema, rawLabelProblem, rawLabelOwnerForRouter } from '../models/traefik';
import { accessAllowedExpression } from '../services/accessControl';
import { buildTraefikLabels } from '../services/traefikLabels';
import { AppDefinitionSchema, type AppService } from '../models/app';
import { generateComposeFile } from '../services/composeGenerator';
import type { OverwatchConfig } from '../config/schema';
import * as yaml from 'js-yaml';

const policy: AccessControl = {
  default_action: 'deny',
  rules: [
    { action: 'deny', path_regex: '^/(internal|debug)(/|$)' },
    { action: 'allow', path_regex: '^/(health|api/webhooks/provider)$' },
    { action: 'allow', source_ranges: ['203.0.113.0/24', '2001:db8:1234::/48'] },
  ],
};
const service: AppService = { name: 'web', required: true, is_init_container: false, ports: { internal: 3000 } };
const app = (access: AccessControl | undefined = policy) => AppDefinitionSchema.parse({
  id: 'product', name: 'Product', domain_template: '*.example.com',
  registry: { type: 'ghcr', url: 'ghcr.io', repository: 'o/product', auth: { type: 'token' } },
  services: [service], traefik: { access_control: access }, createdAt: '', updatedAt: '',
});
function labelsFor(access = policy, svc = service) {
  return buildTraefikLabels({ app: app(access), tenantId: 'acme', domain: 'acme.example.com', service: svc, certResolverName: 'le' });
}
function labelMap(labels: string[]) {
  return Object.fromEntries(labels.map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
}

// Interpret only the generated matcher language. Never evaluate path/regex/IP
// input as code: matcher literals are parsed as JSON and reduced to booleans.
function evaluate(expression: string, path: string, ip: string) {
  const booleans = expression.replace(/(PathRegexp|ClientIP)\(("(?:\\.|[^"\\])*")\)/g, (_, kind, arg) => {
    const value: string = JSON.parse(arg);
    if (kind === 'PathRegexp') return String(Number(RE2JS.compile(value).matcher(path).find()));
    const [address, prefix] = value.split('/');
    const block = new BlockList();
    const family = isIP(address) === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) block.addAddress(address, family);
    else block.addSubnet(address, Number(prefix), family);
    return String(Number(block.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6')));
  });
  expect(booleans).toMatch(/^[01\s!&|()]+$/);
  return Boolean(Function(`return (${booleans});`)());
}

describe('access policy validation', () => {
  it('accepts Go regex syntax, IPv4/IPv6 addresses, CIDRs and bounded matching rules', () => {
    expect(AccessControlSchema.parse(policy)).toEqual(policy);
    expect(AccessControlSchema.safeParse({ default_action: 'allow', rules: [
      { action: 'deny', path_regex: '(?i)^/private/\\p{Greek}+$', source_ranges: [' 192.0.2.1 ', '::1', '0.0.0.0/0', '::/0'] },
    ] }).success).toBe(true);
  });
  it.each(['192.0.2.1/33', '::1/129', '1.2.3', '10.0.0.1/-1', '10.0.0.1/01', '10.0.0.1/24/1', '::1%eth0', 'anything', '10.0.0.1,0.0.0.0/0'])('rejects invalid IP range %s', range => {
    expect(AccessControlSchema.safeParse({ default_action: 'deny', rules: [{ action: 'allow', source_ranges: [range] }] }).success).toBe(false);
  });
  it.each(['[', '(?=x)', '(?<=x)', '(x)\\1', '^/x\ny', '^/x\u2028y', 'a{1001}'])('rejects invalid/unsupported or multiline regex %s', path_regex => {
    expect(AccessControlSchema.safeParse({ default_action: 'deny', rules: [{ action: 'allow', path_regex }] }).success).toBe(false);
  });
  it('requires an explicit fallback, rule action and at least one condition', () => {
    for (const bad of [ {}, { rules: [] }, { default_action: 'deny' },
      { default_action: 'allow', rules: [{ action: 'deny' }] },
      { default_action: 'deny', rules: [{ action: 'allow', source_ranges: [] }] },
      { default_action: 'deny', rules: [{ path_regex: '^/health$' }] },
    ]) expect(AccessControlSchema.safeParse(bad).success).toBe(false);
    expect(AccessControlSchema.safeParse({ default_action: 'deny', rules: Array(51).fill(policy.rules[0]) }).success).toBe(false);
    expect(TraefikAppSchema.parse({ access_control: policy }).access_control).toEqual(policy);
  });
  it('rejects typos instead of silently broadening a rule or discarding a restriction', () => {
    expect(AccessControlSchema.safeParse({ default_action: 'allow', rules: [], ruless: [] }).success).toBe(false);
    expect(AccessControlSchema.safeParse({ default_action: 'deny', rules: [
      { action: 'allow', path_regex: '^/partner$', source_range: ['192.0.2.1'] },
    ] }).success).toBe(false);
  });
});

describe('ordered access decisions', () => {
  it.each([
    ['/dashboard', '203.0.113.8', true], ['/dashboard', '2001:db8:1234::8', true],
    ['/dashboard', '198.51.100.8', false], ['/dashboard', '2001:db8:9999::8', false],
    ['/internal', '203.0.113.8', false], ['/debug/logs', '2001:db8:1234::8', false],
    ['/health', '198.51.100.8', true], ['/api/webhooks/provider', '198.51.100.8', true],
    ['/health/admin', '198.51.100.8', false], ['/api/webhooks/provider-evil', '198.51.100.8', false],
  ])('decides %s from %s as %s', (path, ip, allowed) => {
    expect(evaluate(accessAllowedExpression(policy), path, ip)).toBe(allowed);
  });
  it('uses AND between path and IP conditions, and OR between listed IP ranges', () => {
    const p: AccessControl = { default_action: 'deny', rules: [{ action: 'allow', path_regex: '^/partner(/|$)', source_ranges: ['192.0.2.1', '2001:db8::1'] }] };
    for (const [path, ip, allowed] of [
      ['/partner/hook', '192.0.2.1', true], ['/partner', '2001:db8::1', true],
      ['/partner', '192.0.2.2', false], ['/admin', '192.0.2.1', false],
    ] as const) expect(evaluate(accessAllowedExpression(p), path, ip)).toBe(allowed);
  });
  it('supports allow-by-default blacklists and earlier allow exceptions to denies', () => {
    const p: AccessControl = { default_action: 'allow', rules: [
      { action: 'allow', path_regex: '^/internal/health$' },
      { action: 'deny', path_regex: '^/internal(/|$)' },
      { action: 'deny', source_ranges: ['198.51.100.0/24'] },
    ] };
    expect(evaluate(accessAllowedExpression(p), '/internal/health', '198.51.100.1')).toBe(true);
    expect(evaluate(accessAllowedExpression(p), '/internal', '192.0.2.1')).toBe(false);
    expect(evaluate(accessAllowedExpression(p), '/', '198.51.100.1')).toBe(false);
    expect(evaluate(accessAllowedExpression(p), '/', '192.0.2.1')).toBe(true);
  });
  it('supports deny-all/allow-all with no rules', () => {
    for (const action of ['allow', 'deny'] as const) {
      expect(evaluate(accessAllowedExpression({ default_action: action, rules: [] }), '/', '::1')).toBe(action === 'allow');
    }
  });
  it('quotes regex text without altering escapes, quotes, backticks, equals signs or rule-like text', () => {
    const path = '/a"`)=x||ClientIP("0.0.0.0/0")';
    const literal = '^' + path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
    const expression = accessAllowedExpression({ default_action: 'deny', rules: [{ action: 'allow', path_regex: literal }] });
    expect(evaluate(expression, path, '192.0.2.1')).toBe(true);
    expect(evaluate(expression, '/unrelated', '192.0.2.1')).toBe(false);
  });
});

describe('proxy policy enforcement', () => {
  const router = 'traefik.http.routers.product-acme-web';
  it('uses complementary allow/deny routes at the original priority with explicit service and TLS', () => {
    const labels = labelMap(labelsFor());
    expect(labels[`${router}.priority`]).toBe(String(Buffer.byteLength('Host(`acme.example.com`)')));
    expect(labels[`${router}-_access_denied.priority`]).toBe(labels[`${router}.priority`]);
    for (const name of [router, `${router}-_access_denied`]) {
      expect(labels[`${name}.service`]).toBe('product-acme-web');
      expect(labels[`${name}.tls`]).toBe('true');
      expect(labels[`${name}.tls.certresolver`]).toBe('le');
      expect(labels[`${name}.entrypoints`]).toBe('websecure');
    }
    const prefix = '(Host(`acme.example.com`)) && ';
    for (const path of ['/health', '/internal', '/dashboard']) {
      const a = evaluate(labels[`${router}.rule`].slice(prefix.length), path, '198.51.100.8');
      const d = evaluate(labels[`${router}-_access_denied.rule`].slice(prefix.length), path, '198.51.100.8');
      expect(Number(a) + Number(d)).toBe(1);
    }
    expect(labels[`${router}-_access_denied.middlewares`]).toBe('product-acme-web-_access_deny0,product-acme-web-_access_deny1');
  });
  it('retains aliases, prefix constraints, upstream mode, priority and all ordinary middleware on allowed URLs', () => {
    const definition = app();
    definition.traefik!.middlewares = { auth: { type: 'basicAuth', users: ['u:hash'] } };
    definition.traefik!.default_middlewares = ['auth'];
    const labels = labelMap(buildTraefikLabels({ app: definition, tenantId: 'acme', domain: 'acme.example.com', certResolverName: 'le',
      service: { ...service, routing: { enabled: true, strip_prefix: true, path_prefix: '/api', additional_path_prefixes: ['/hooks'], priority: 100 } },
      tenantOverrides: { host_aliases: ['alias.example.com'], tls_termination: 'upstream' },
    }));
    expect(labels[`${router}.rule`]).toContain('Host(`alias.example.com`)');
    expect(labels[`${router}-_access_denied.rule`]).toContain('PathPrefix(`/api`) || PathPrefix(`/hooks`)');
    expect(labels[`${router}.middlewares`]).toBe('product-acme-web-auth,product-acme-web-_stripprefix');
    expect(labels[`${router}-_access_denied.priority`]).toBe('100');
    expect(labels[`${router}-_access_denied.entrypoints`]).toBe('web');
    expect(labels[`${router}-_access_denied.tls`]).toBeUndefined();
  });
  it('does not let raw labels rewrite internal policy objects, or a tenant middleware override remove the policy', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const labels = labelMap(buildTraefikLabels({ app: app(), tenantId: 'acme', domain: 'acme.example.com', certResolverName: 'le', service,
        tenantOverrides: { middleware_overrides: { web: [] }, raw_labels: { web: {
          'traefik.http.middlewares.product-acme-web-_access_deny0.ipallowlist.sourcerange': '0.0.0.0/0,::/0',
          [`${router}-_access_denied.middlewares`]: '',
          [`${router}.rule`]: 'Host(`evil.example.com`)',
        } } },
      }));
      expect(labels['traefik.http.middlewares.product-acme-web-_access_deny0.ipallowlist.sourcerange']).toBe('0.0.0.0/1');
      expect(labels[`${router}-_access_denied.middlewares`]).toContain('_access_deny0');
      expect(labels[`${router}.rule`]).not.toContain('evil');
      expect(rawLabelProblem('traefik.http.middlewares.product-acme-web-_access_deny0.ipallowlist.sourcerange', '0.0.0.0/0', rawLabelOwnerForRouter('product-acme-web'))).toMatch(/reserved/);
    } finally { warn.mockRestore(); }
  });
  it('avoids collisions with legacy typed middleware names in the reserved namespace', () => {
    const definition = app();
    definition.traefik!.middlewares = { _access_deny0: { type: 'compress' } };
    definition.traefik!.default_middlewares = ['_access_deny0'];
    const labels = labelMap(buildTraefikLabels({ app: definition, tenantId: 'acme', domain: 'acme.example.com', certResolverName: 'le', service }));
    expect(labels['traefik.http.middlewares.product-acme-web-_access_deny0.compress']).toBe('true');
    expect(labels['traefik.http.middlewares.product-acme-web-_access_deny0.ipallowlist.sourcerange']).toBeUndefined();
    expect(labels[`${router}-_access_denied.middlewares`]).toMatch(/^product-acme-web-_access_deny1,product-acme-web-_access_deny2,/);
  });
  it('leaves projects without a policy unchanged and never exposes disabled/init/portless services', () => {
    const definition = app(); delete definition.traefik!.access_control;
    expect(buildTraefikLabels({ app: definition, tenantId: 'acme', domain: 'acme.example.com', certResolverName: 'le', service }).join('\n')).not.toContain('_access_');
    for (const svc of [{ ...service, is_init_container: true }, { ...service, ports: undefined }, { ...service, routing: { enabled: false, strip_prefix: false } }]) {
      expect(labelsFor(policy, svc)).toEqual([]);
    }
  });
  it('preserves policy predicates through Compose escaping of regex dollars and backslashes', () => {
    const definition = app();
    const compose = yaml.load(generateComposeFile({ app: definition, tenantId: 'acme', domain: 'acme.example.com', config: { project: { prefix: 'test' }, networking: {} } as OverwatchConfig })) as any;
    const labels: string[] = Object.values<any>(compose.services)[0].labels;
    expect(labels.join('\n')).toContain('provider)$$');
    expect(labels.join('\n').replace(/\$\$/g, '$')).toContain(accessAllowedExpression(policy));
  });
});
