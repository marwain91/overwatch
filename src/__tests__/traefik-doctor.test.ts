import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const runDockerMock = vi.fn();
vi.mock('../utils/runDocker', async (orig) => ({
  ...(await orig<typeof import('../utils/runDocker')>()),
  runDocker: (...a: unknown[]) => runDockerMock(...a),
}));

import { validateTraefik, collectPresentEnvVars, resolveNetworkGateways, type DoctorContext } from '../services/traefikDoctor';
import type { OverwatchConfig } from '../config/schema';
import type { AppDefinition } from '../models/app';
import type { Entrypoint, TraefikGlobal, TraefikTenant } from '../models/traefik';

function ctxOf(overrides: Partial<DoctorContext>): DoctorContext {
  return {
    config: { project: { name: 'p', prefix: 'p', db_prefix: 'p' }, database: {} as any },
    apps: [],
    tenantOverrides: new Map(),
    presentEnvVars: new Set(),
    ...overrides,
  } as DoctorContext;
}

function withTraefik(t: Partial<TraefikGlobal>): OverwatchConfig {
  return { project: { name: 'p', prefix: 'p', db_prefix: 'p' }, database: {} as any, traefik: t } as OverwatchConfig;
}

describe('validateTraefik — middleware references', () => {
  it('flags an app default_middleware that does not exist anywhere', () => {
    const app = {
      id: 'a', name: 'A', services: [], default_image_tag: 'latest',
      registry: { type: 'ghcr', url: 'g.io', repository: 'a/b', auth: { type: 'token' } },
      traefik: { default_middlewares: ['ghost'] },
      createdAt: '', updatedAt: '',
    } as unknown as AppDefinition;
    const issues = validateTraefik(ctxOf({ apps: [app] }));
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].scope).toBe('app:a.traefik.default_middlewares');
  });

  it('accepts an app default_middleware defined globally', () => {
    const app = {
      id: 'a', name: 'A', services: [], default_image_tag: 'latest',
      registry: { type: 'ghcr', url: 'g.io', repository: 'a/b', auth: { type: 'token' } },
      traefik: { default_middlewares: ['hsts'] },
      createdAt: '', updatedAt: '',
    } as unknown as AppDefinition;
    const issues = validateTraefik(ctxOf({
      config: withTraefik({ middlewares: { hsts: { type: 'headers', sts_seconds: 31536000 } } }),
      apps: [app],
    }));
    expect(issues).toEqual([]);
  });

  it('flags a service routing.middlewares that points to a missing name', () => {
    const app = {
      id: 'a', name: 'A', default_image_tag: 'latest',
      registry: { type: 'ghcr', url: 'g.io', repository: 'a/b', auth: { type: 'token' } },
      services: [{ name: 'web', required: true, is_init_container: false, ports: { internal: 3000 }, routing: { enabled: true, strip_prefix: false, middlewares: ['ghost'] } }],
      createdAt: '', updatedAt: '',
    } as unknown as AppDefinition;
    const issues = validateTraefik(ctxOf({ apps: [app] }));
    expect(issues.some(i => i.scope.includes('service:web'))).toBe(true);
  });

  it('flags a tenant middleware_override with a missing name', () => {
    const overrides = new Map<string, Map<string, TraefikTenant>>([
      ['a', new Map([['t1', { middleware_overrides: { web: ['ghost'] } } as TraefikTenant]])],
    ]);
    const issues = validateTraefik(ctxOf({ tenantOverrides: overrides }));
    expect(issues.some(i => i.scope === 'tenant:a/t1.middleware_overrides.web')).toBe(true);
  });

  it('flags dashboard.middlewares pointing to a missing middleware', () => {
    const issues = validateTraefik(ctxOf({
      config: withTraefik({
        dashboard: { enabled: true, middlewares: ['ghost'] },
      } as TraefikGlobal),
    }));
    expect(issues.some(i => i.scope === 'traefik.dashboard.middlewares')).toBe(true);
  });
});

describe('validateTraefik — cert resolvers', () => {
  it('flags a tenant cert_resolver that does not exist', () => {
    const overrides = new Map<string, Map<string, TraefikTenant>>([
      ['a', new Map([['t1', { cert_resolver: 'ghost' } as TraefikTenant]])],
    ]);
    const issues = validateTraefik(ctxOf({
      config: withTraefik({ cert_resolvers: [{ name: 'real', challenge: 'http', acme_email: 'a@b.c', entrypoint: 'web' }] } as TraefikGlobal),
      tenantOverrides: overrides,
    }));
    expect(issues.some(i => i.scope === 'tenant:a/t1.cert_resolver')).toBe(true);
  });

  it('flags missing http fallback when no resolver has universal patterns', () => {
    const issues = validateTraefik(ctxOf({
      config: withTraefik({
        cert_resolvers: [{ name: 'cf', challenge: 'dns', provider: 'cloudflare', acme_email: 'a@b.c', domain_patterns: ['*.example.com'] }],
      } as TraefikGlobal),
    }));
    expect(issues.some(i => i.scope === 'traefik.cert_resolvers' && i.severity === 'warning')).toBe(true);
  });

  it('passes when resolver has a "*" pattern', () => {
    const issues = validateTraefik(ctxOf({
      config: withTraefik({
        cert_resolvers: [{ name: 'cf', challenge: 'dns', provider: 'cloudflare', acme_email: 'a@b.c', domain_patterns: ['*'] }],
      } as TraefikGlobal),
    }));
    expect(issues.filter(i => i.severity === 'warning')).toEqual([]);
  });

  it('flags a missing env var referenced in cert resolver env', () => {
    const issues = validateTraefik(ctxOf({
      config: withTraefik({
        cert_resolvers: [{
          name: 'cf', challenge: 'dns', provider: 'cloudflare', acme_email: 'a@b.c',
          env: { CF_DNS_API_TOKEN: '${CF_TOKEN}' },
          domain_patterns: ['*'],
        }],
      }),
      presentEnvVars: new Set(['SOMETHING_ELSE']),
    }));
    expect(issues.some(i => i.message.includes('${CF_TOKEN}'))).toBe(true);
  });

  it('passes when the env var is present', () => {
    const issues = validateTraefik(ctxOf({
      config: withTraefik({
        cert_resolvers: [{
          name: 'cf', challenge: 'dns', provider: 'cloudflare', acme_email: 'a@b.c',
          env: { CF_DNS_API_TOKEN: '${CF_TOKEN}' },
          domain_patterns: ['*'],
        }],
      }),
      presentEnvVars: new Set(['CF_TOKEN']),
    }));
    expect(issues.filter(i => i.message.includes('${'))).toEqual([]);
  });

  it('flags placeholder values from the legacy shim', () => {
    const issues = validateTraefik(ctxOf({
      config: withTraefik({
        cert_resolvers: [{
          name: 'leg', challenge: 'dns', provider: 'legacy', acme_email: 'legacy@overwatch.local',
          domain_patterns: ['*'],
        }],
      }),
    }));
    expect(issues.some(i => i.message.includes('placeholder'))).toBe(true);
  });
});

describe('validateTraefik — upstream TLS', () => {
  it('warns when termination=upstream and the entrypoint has no trust list', () => {
    const issues = validateTraefik(ctxOf({
      config: withTraefik({
        tls_termination: 'upstream',
        upstream_entrypoint: 'web',
        entrypoints: [{ name: 'web', port: 80 }],
      } as TraefikGlobal),
    }));
    expect(issues.some(i => i.message.includes('forwarded_headers'))).toBe(true);
  });

  it('errors when upstream_entrypoint references a missing entrypoint', () => {
    const issues = validateTraefik(ctxOf({
      config: withTraefik({
        tls_termination: 'upstream',
        upstream_entrypoint: 'edge',
        entrypoints: [{ name: 'web', port: 80 }],
      } as TraefikGlobal),
    }));
    expect(issues.some(i => i.severity === 'error' && i.scope === 'traefik.upstream_entrypoint')).toBe(true);
  });

  it('passes when termination=upstream and trust list is configured', () => {
    const issues = validateTraefik(ctxOf({
      config: withTraefik({
        tls_termination: 'upstream',
        upstream_entrypoint: 'web',
        entrypoints: [{ name: 'web', port: 80, forwarded_headers: { trusted_ips: ['10.0.0.0/8'] } }],
      } as TraefikGlobal),
    }));
    expect(issues.filter(i => i.scope.includes('forwarded_headers'))).toEqual([]);
  });

  it('does not flag forwarded_headers when termination is the default (traefik)', () => {
    const issues = validateTraefik(ctxOf({
      config: withTraefik({} as TraefikGlobal),
    }));
    expect(issues.filter(i => i.scope.includes('forwarded_headers'))).toEqual([]);
  });
});

describe('validateTraefik — forwarded-header trust behind a same-host proxy', () => {
  const TRUST_SCOPE = 'traefik.entrypoints["web"].forwarded_headers.trusted_ips';

  // The production shape: host nginx terminates TLS and proxies to 127.0.0.1:8080.
  function behindHostProxy(ep: Partial<Entrypoint> = {}): OverwatchConfig {
    return withTraefik({
      tls_termination: 'upstream',
      upstream_entrypoint: 'web',
      entrypoints: [{
        name: 'web', port: 80, host_port: 8080, host_bind: '127.0.0.1',
        forwarded_headers: { trusted_ips: ['127.0.0.1/32'] },
        ...ep,
      }],
    } as TraefikGlobal);
  }
  const trustIssues = (ctx: Partial<DoctorContext>) =>
    validateTraefik(ctxOf(ctx)).filter(i => i.scope === TRUST_SCOPE);

  it('warns when a loopback-bound entrypoint trusts only loopback', () => {
    const issues = trustIssues({ config: behindHostProxy() });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toMatch(/gateway/);
    // Without a resolved gateway, the hint says how to look it up.
    expect(issues[0].hint).toContain('docker network inspect');
  });

  it('names the resolved gateway as a /32 in the hint', () => {
    const issues = trustIssues({
      config: behindHostProxy(),
      sharedNetwork: { name: 'daktela-network', gateways: ['172.18.0.1'] },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('daktela-network');
    expect(issues[0].message).toContain('172.18.0.1');
    expect(issues[0].hint).toContain('"172.18.0.1/32"');
    expect(issues[0].hint).not.toContain('172.18.0.0/16');
  });

  it('passes once the gateway is trusted (the production fix)', () => {
    expect(trustIssues({
      config: behindHostProxy({ forwarded_headers: { trusted_ips: ['127.0.0.1/32', '172.18.0.1/32'] } }),
      sharedNetwork: { name: 'daktela-network', gateways: ['172.18.0.1'] },
    })).toEqual([]);
  });

  it('accepts the gateway written as a bare address or inside a wider range', () => {
    for (const trusted of [['172.18.0.1'], ['172.18.0.0/16']]) {
      expect(trustIssues({
        config: behindHostProxy({ forwarded_headers: { trusted_ips: trusted } }),
        sharedNetwork: { name: 'n', gateways: ['172.18.0.1'] },
      })).toEqual([]);
    }
  });

  it('warns when a loopback-bound entrypoint trusts a different gateway', () => {
    // 172.17.0.1 is docker0's gateway, a common guess, but not the shared network's.
    const issues = trustIssues({
      config: behindHostProxy({ forwarded_headers: { trusted_ips: ['127.0.0.1/32', '172.17.0.1/32'] } }),
      sharedNetwork: { name: 'daktela-network', gateways: ['172.18.0.1'] },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('127.0.0.1');
    expect(issues[0].hint).toContain('"172.18.0.1/32"');
  });

  it('warns about loopback-only trust on any bind address, IPv4 or IPv6', () => {
    for (const ep of [
      { host_bind: undefined },
      { host_bind: '::1', forwarded_headers: { trusted_ips: ['::1/128'] } },
      { forwarded_headers: { trusted_ips: ['127.0.0.0/8'] } },
    ]) {
      expect(trustIssues({ config: behindHostProxy(ep) })).toHaveLength(1);
    }
  });

  it('does not judge a non-loopback trust list on a public bind', () => {
    // A remote upstream (ALB, Cloudflare) connects with its own address, not the gateway.
    expect(trustIssues({
      config: behindHostProxy({ host_bind: undefined, forwarded_headers: { trusted_ips: ['10.0.0.0/8'] } }),
      sharedNetwork: { name: 'n', gateways: ['172.18.0.1'] },
    })).toEqual([]);
  });

  it('is silent when TLS terminates at Traefik', () => {
    const config = withTraefik({
      entrypoints: [{ name: 'web', port: 80, host_bind: '127.0.0.1', forwarded_headers: { trusted_ips: ['127.0.0.1/32'] } }],
    } as TraefikGlobal);
    expect(trustIssues({ config })).toEqual([]);
  });
});

describe('resolveNetworkGateways', () => {
  beforeEach(() => { runDockerMock.mockReset(); });

  it('returns every gateway of the network', async () => {
    runDockerMock.mockResolvedValue({
      stdout: '[{"Subnet":"172.18.0.0/16","Gateway":"172.18.0.1"},{"Subnet":"fd00:1::/64","Gateway":"fd00:1::1"}]\n',
      stderr: '',
    });
    await expect(resolveNetworkGateways('daktela-network')).resolves.toEqual(['172.18.0.1', 'fd00:1::1']);
    expect(runDockerMock).toHaveBeenCalledWith(
      'docker', ['network', 'inspect', '--format', '{{json .IPAM.Config}}', 'daktela-network'], expect.any(Object),
    );
  });

  it('skips IPAM entries without a usable gateway', async () => {
    runDockerMock.mockResolvedValue({ stdout: '[{"Subnet":"10.9.0.0/24"},{"Gateway":"not-an-ip"}]', stderr: '' });
    await expect(resolveNetworkGateways('n')).resolves.toEqual([]);
    runDockerMock.mockResolvedValue({ stdout: 'null', stderr: '' });
    await expect(resolveNetworkGateways('n')).resolves.toEqual([]);
  });

  it('returns nothing when docker or the network is unavailable', async () => {
    runDockerMock.mockRejectedValue(new Error('No such network'));
    await expect(resolveNetworkGateways('missing')).resolves.toEqual([]);
  });
});

describe('collectPresentEnvVars', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overwatch-doctor-env-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reads keys from <deployDir>/.env', () => {
    const overwatchDir = path.join(tmp, 'overwatch');
    fs.mkdirSync(overwatchDir, { recursive: true });
    fs.writeFileSync(path.join(overwatchDir, '.env'), 'JWT_SECRET=abc\nGOOGLE_CLIENT_ID=xyz\n');
    const out = collectPresentEnvVars(overwatchDir);
    expect(out.has('JWT_SECRET')).toBe(true);
    expect(out.has('GOOGLE_CLIENT_ID')).toBe(true);
  });

  it('also reads sibling .env files (e.g. infrastructure/.env)', () => {
    // Mirrors the standard layout: <root>/overwatch/.env + <root>/infrastructure/.env
    const overwatchDir = path.join(tmp, 'overwatch');
    const infraDir = path.join(tmp, 'infrastructure');
    fs.mkdirSync(overwatchDir, { recursive: true });
    fs.mkdirSync(infraDir, { recursive: true });
    fs.writeFileSync(path.join(overwatchDir, '.env'), 'JWT_SECRET=abc\n');
    fs.writeFileSync(path.join(infraDir, '.env'), 'CF_DNS_API_TOKEN=token-xyz\nACME_EMAIL=a@b.c\n');
    const out = collectPresentEnvVars(overwatchDir);
    expect(out.has('JWT_SECRET')).toBe(true);
    expect(out.has('CF_DNS_API_TOKEN')).toBe(true);
    expect(out.has('ACME_EMAIL')).toBe(true);
  });

  it('still returns process.env when deployDir is undefined', () => {
    const out = collectPresentEnvVars(undefined);
    expect(out.has('PATH')).toBe(true);
  });

  it('handles missing .env files silently', () => {
    const out = collectPresentEnvVars(tmp);
    expect(out.size).toBeGreaterThan(0); // process.env keys at minimum
  });
});
