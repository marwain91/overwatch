import { describe, it, expect } from 'vitest';
import { resolveCertResolver, resolveMiddlewareChain, domainMatchesPattern } from '../config/loader';
import { isDenylistedLabelKey, RawLabelsSchema, type TraefikGlobal } from '../models/traefik';

describe('domainMatchesPattern', () => {
  it('matches exact domains', () => {
    expect(domainMatchesPattern('foo.example.com', 'foo.example.com')).toBe(true);
    expect(domainMatchesPattern('foo.example.com', 'bar.example.com')).toBe(false);
  });
  it('matches wildcard glob with leading *.', () => {
    expect(domainMatchesPattern('a.example.com', '*.example.com')).toBe(true);
    expect(domainMatchesPattern('deep.sub.example.com', '*.example.com')).toBe(true);
    expect(domainMatchesPattern('example.com', '*.example.com')).toBe(true); // base also matches
    expect(domainMatchesPattern('example.org', '*.example.com')).toBe(false);
  });
  it('matches universal *', () => {
    expect(domainMatchesPattern('anything.tld', '*')).toBe(true);
    expect(domainMatchesPattern('', '*')).toBe(true);
  });
});

describe('resolveCertResolver', () => {
  const traefik: TraefikGlobal = {
    log_level: 'INFO',
    cert_resolvers: [
      { name: 'cf-prod', challenge: 'dns', provider: 'cloudflare', acme_email: 'a@b.c', domain_patterns: ['*.app.example.com'] },
      { name: 'gandi-eu', challenge: 'dns', provider: 'gandi', acme_email: 'a@b.c', domain_patterns: ['*.example.eu'] },
      { name: 'http', challenge: 'http', acme_email: 'a@b.c', entrypoint: 'web' },
    ],
  };

  it('honors explicit tenant override', () => {
    const r = resolveCertResolver('whatever.example.com', traefik, 'gandi-eu');
    expect(r.name).toBe('gandi-eu');
  });

  it('throws when override does not exist', () => {
    expect(() => resolveCertResolver('a.example.com', traefik, 'nonexistent')).toThrow(/not defined/);
  });

  it('matches by domain pattern (longest wins)', () => {
    const more: TraefikGlobal = {
      log_level: 'INFO',
      cert_resolvers: [
        { name: 'wide', challenge: 'dns', provider: 'cloudflare', acme_email: 'a@b.c', domain_patterns: ['*.com'] },
        { name: 'narrow', challenge: 'dns', provider: 'cloudflare', acme_email: 'a@b.c', domain_patterns: ['*.app.example.com'] },
        { name: 'http', challenge: 'http', acme_email: 'a@b.c', entrypoint: 'web' },
      ],
    };
    expect(resolveCertResolver('x.app.example.com', more).name).toBe('narrow');
  });

  it('falls back to first http-challenge resolver without patterns', () => {
    expect(resolveCertResolver('totally-random.io', traefik).name).toBe('http');
  });

  it('errors when no match and no http fallback', () => {
    const noFallback: TraefikGlobal = {
      log_level: 'INFO',
      cert_resolvers: [
        { name: 'cf-prod', challenge: 'dns', provider: 'cloudflare', acme_email: 'a@b.c', domain_patterns: ['*.app.example.com'] },
      ],
    };
    expect(() => resolveCertResolver('elsewhere.tld', noFallback)).toThrow(/No cert resolver matches/);
  });
});

describe('resolveMiddlewareChain', () => {
  const global = {
    'hsts': { type: 'headers' as const, sts_seconds: 31536000 },
    'rl': { type: 'rateLimit' as const, average: 100 },
  };
  const app = {
    'app-rl': { type: 'rateLimit' as const, average: 50, burst: 100 },
  };

  it('resolves names from app first, then global', () => {
    const chain = resolveMiddlewareChain(['app-rl', 'hsts'], { app, global });
    expect(chain).toHaveLength(2);
    expect(chain[0].name).toBe('app-rl');
    expect(chain[1].name).toBe('hsts');
    expect(chain[0].spec.type).toBe('rateLimit');
    expect(chain[1].spec.type).toBe('headers');
  });

  it('throws on dangling reference', () => {
    expect(() => resolveMiddlewareChain(['unknown'], { app, global })).toThrow(/not defined/);
  });

  it('app-scope shadows global with same name', () => {
    const chain = resolveMiddlewareChain(['rl'], {
      app: { 'rl': { type: 'rateLimit', average: 999 } },
      global,
    });
    expect((chain[0].spec as any).average).toBe(999);
  });
});

describe('isDenylistedLabelKey', () => {
  it('rejects reserved keys', () => {
    expect(isDenylistedLabelKey('traefik.enable')).toBe(true);
    expect(isDenylistedLabelKey('traefik.http.routers.foo.rule')).toBe(true);
    expect(isDenylistedLabelKey('traefik.http.routers.bar.tls.certresolver')).toBe(true);
    expect(isDenylistedLabelKey('traefik.http.routers.bar.entrypoints')).toBe(true);
    expect(isDenylistedLabelKey('traefik.http.routers.bar.tls')).toBe(true);
  });
  it('allows other keys', () => {
    expect(isDenylistedLabelKey('traefik.http.routers.bar.priority')).toBe(false);
    expect(isDenylistedLabelKey('traefik.http.services.bar.loadbalancer.server.port')).toBe(false);
    expect(isDenylistedLabelKey('traefik.http.middlewares.foo.ratelimit.average')).toBe(false);
    expect(isDenylistedLabelKey('something.else.entirely')).toBe(false);
  });
});

describe('RawLabelsSchema', () => {
  it('rejects denylisted keys via Zod refinement', () => {
    const result = RawLabelsSchema.safeParse({
      'traefik.http.routers.foo.priority': '50',
      'traefik.http.routers.foo.rule': 'Host(`x.com`)',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.errors.map(e => e.message).join('\n');
      expect(messages).toMatch(/reserved by Overwatch/);
      expect(messages).toMatch(/traefik\.http\.routers\.foo\.rule/);
    }
  });

  it('accepts non-denylisted labels', () => {
    const result = RawLabelsSchema.safeParse({
      'traefik.http.routers.foo.priority': '50',
      'my.custom.label': 'value',
    });
    expect(result.success).toBe(true);
  });
});
