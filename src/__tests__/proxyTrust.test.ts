import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { IncomingMessage } from 'http';
import * as fs from 'fs/promises';
import * as path from 'path';
import { pinTrustToProxyHost, clientIpOf, resolveTrustProxySetting, type PinnedProxyTrust, type TrustFn } from '../utils/proxyTrust';

const quiet = () => ({ warn: vi.fn(), info: vi.fn() });
const pinned: PinnedProxyTrust[] = [];
async function pin(setting: ReturnType<typeof resolveTrustProxySetting>, opts: Parameters<typeof pinTrustToProxyHost>[1]) {
  const p = await pinTrustToProxyHost(setting, opts);
  pinned.push(p);
  return p;
}
afterEach(() => { for (const p of pinned.splice(0)) p.stop(); });

function fn(p: PinnedProxyTrust): TrustFn {
  expect(typeof p.setting).toBe('function');
  return p.setting as TrustFn;
}

describe('pinTrustToProxyHost', () => {
  it('trusts the forwarded hop only when the socket peer is the resolved proxy', async () => {
    const p = await pin(1, { host: 'ow-traefik', lookup: async () => ['172.18.0.2'], log: quiet() });
    const trust = fn(p);
    expect(trust('172.18.0.2', 0)).toBe(true);
    expect(trust('::ffff:172.18.0.2', 0)).toBe(true); // dual-stack socket address
    expect(trust('172.18.0.9', 0)).toBe(false);       // a tenant container on the shared network
    expect(trust('1.2.3.4', 1)).toBe(false);          // only one hop
  });

  it('keeps further hops when more than one is configured, but the first must still be the proxy', async () => {
    const trust = fn(await pin(2, { host: 'ow-traefik', lookup: async () => ['172.18.0.2'], log: quiet() }));
    expect(trust('172.18.0.2', 0)).toBe(true);
    expect(trust('203.0.113.7', 1)).toBe(true);
    expect(trust('198.51.100.1', 2)).toBe(false);
    expect(trust('172.18.0.9', 0)).toBe(false);
  });

  it('falls back to trusting any peer one hop away, loudly, when the proxy cannot be resolved', async () => {
    const log = quiet();
    const trust = fn(await pin(1, { host: 'ow-traefik', lookup: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); }, log }));
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/ow-traefik[\s\S]*OVERWATCH_TRUST_PROXY/));
    expect(trust('172.18.0.9', 0)).toBe(true);
    expect(trust('1.2.3.4', 1)).toBe(false);
  });

  it('falls back when the lookup hangs past the timeout', async () => {
    const log = quiet();
    const trust = fn(await pin(1, { host: 'ow-traefik', lookup: () => new Promise<string[]>(() => {}), lookupTimeoutMs: 20, log }));
    expect(log.warn).toHaveBeenCalled();
    expect(trust('172.18.0.9', 0)).toBe(true);
  });

  it('pins once a later refresh resolves the proxy', async () => {
    let addrs: string[] | null = null;
    const log = quiet();
    const p = await pin(1, { host: 'ow-traefik', lookup: async () => { if (!addrs) throw new Error('ENOTFOUND'); return addrs; }, log });
    const trust = fn(p);
    expect(trust('172.18.0.9', 0)).toBe(true);
    addrs = ['172.18.0.2'];
    await p.refresh();
    expect(trust('172.18.0.9', 0)).toBe(false);
    expect(trust('172.18.0.2', 0)).toBe(true);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('172.18.0.2'));
  });

  it('keeps the last known proxy address when a refresh fails, and follows an address change', async () => {
    let result: string[] | Error = ['172.18.0.2'];
    const p = await pin(1, { host: 'ow-traefik', lookup: async () => { if (result instanceof Error) throw result; return result; }, log: quiet() });
    const trust = fn(p);
    result = new Error('EAI_AGAIN');
    await p.refresh();
    expect(trust('172.18.0.2', 0)).toBe(true);
    expect(trust('172.18.0.9', 0)).toBe(false);
    result = ['172.18.0.5'];
    await p.refresh();
    expect(trust('172.18.0.5', 0)).toBe(true);
    expect(trust('172.18.0.2', 0)).toBe(false);
  });

  it('refreshes periodically', async () => {
    let calls = 0;
    await pin(1, { host: 'ow-traefik', lookup: async () => { calls++; return ['172.18.0.2']; }, refreshMs: 10, log: quiet() });
    await vi.waitFor(() => expect(calls).toBeGreaterThan(2));
  });

  it.each([
    ['an explicit address list', '172.18.0.0/16'],
    ['trust disabled', false],
    ['trust everything', true],
  ] as const)('leaves %s untouched and never resolves the host', async (_label, setting) => {
    const lookup = vi.fn(async () => ['172.18.0.2']);
    const p = await pin(setting, { host: 'ow-traefik', lookup, log: quiet() });
    expect(p.setting).toBe(setting);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('can be switched off with host "none" (the previous behaviour)', async () => {
    const lookup = vi.fn(async () => ['172.18.0.2']);
    const p = await pin(1, { host: 'none', lookup, log: quiet() });
    expect(p.setting).toBe(1);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('Express wiring of the pinned trust', () => {
  async function ipSeen(proxyAddrs: string[], xff?: string) {
    const p = await pin(1, { host: 'ow-traefik', lookup: async () => proxyAddrs, log: quiet() });
    const app = express();
    app.set('trust proxy', p.setting);
    app.get('/', (req, res) => { res.json({ ip: req.ip, ws: clientIpOf(req as unknown as IncomingMessage, app.get('trust proxy fn')) }); });
    const r = request(app).get('/');
    if (xff) r.set('X-Forwarded-For', xff);
    return (await r).body as { ip: string; ws: string };
  }

  it('uses X-Forwarded-For from the proxy', async () => {
    const seen = await ipSeen(['127.0.0.1', '::1'], '203.0.113.7');
    expect(seen.ip).toBe('203.0.113.7');
    expect(seen.ws).toBe(seen.ip);
  });

  it('ignores X-Forwarded-For from any other peer and keys by the peer address', async () => {
    const seen = await ipSeen(['172.18.0.2'], '203.0.113.7');
    expect(seen.ip).toMatch(/127\.0\.0\.1|::1/);
    expect(seen.ws).toBe(seen.ip);
  });
});

describe('flagUntrustedForwarding', () => {
  it('warns once per peer and re-resolves the proxy when another peer sends X-Forwarded-For', async () => {
    const log = quiet();
    let calls = 0;
    const p = await pin(1, { host: 'ow-traefik', lookup: async () => { calls++; return ['172.18.0.2']; }, log });
    const app = express();
    app.set('trust proxy', p.setting);
    app.use(p.flagUntrustedForwarding);
    app.get('/', (_req, res) => { res.json({}); });
    await request(app).get('/').set('X-Forwarded-For', '203.0.113.7');
    await request(app).get('/').set('X-Forwarded-For', '203.0.113.8');
    await request(app).get('/'); // no header: nothing to report
    const warnings = log.warn.mock.calls.flat().filter((m: string) => m.includes('Ignoring X-Forwarded-For'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('OVERWATCH_TRUST_PROXY');
    await vi.waitFor(() => expect(calls).toBe(2)); // startup + one throttled re-resolve
  });

  it('stays quiet for the proxy itself', async () => {
    const log = quiet();
    const p = await pin(1, { host: 'ow-traefik', lookup: async () => ['127.0.0.1', '::1'], log });
    const app = express();
    app.set('trust proxy', p.setting);
    app.use(p.flagUntrustedForwarding);
    app.get('/', (_req, res) => { res.json({}); });
    await request(app).get('/').set('X-Forwarded-For', '203.0.113.7');
    expect(log.warn.mock.calls.flat().join()).not.toContain('Ignoring');
  });
});

describe('clientIpOf', () => {
  const req = (remoteAddress: string, xff?: string | string[]) =>
    ({ socket: { remoteAddress }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } }) as unknown as IncomingMessage;

  it('matches proxy-addr: first untrusted address walking from the socket outwards', () => {
    const hop1: TrustFn = (_a, i) => i < 1;
    expect(clientIpOf(req('10.0.0.1'), hop1)).toBe('10.0.0.1');
    expect(clientIpOf(req('10.0.0.1', '1.1.1.1, 2.2.2.2'), hop1)).toBe('2.2.2.2');
    expect(clientIpOf(req('10.0.0.1', ' , 2.2.2.2 ,'), hop1)).toBe('2.2.2.2');
    expect(clientIpOf(req('10.0.0.1', '1.1.1.1, 2.2.2.2'), () => true)).toBe('1.1.1.1');
    expect(clientIpOf(req('10.0.0.1', '1.1.1.1'), () => false)).toBe('10.0.0.1');
  });
});

describe('src/index.ts proxy trust wiring', () => {
  it('pins the hop count to the Traefik container and flags forged forwarding', async () => {
    const src = await fs.readFile(path.join(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toMatch(/pinTrustToProxyHost\(resolveTrustProxySetting\(\), \{\s*host: process\.env\.OVERWATCH_TRUST_PROXY_HOST\?\.trim\(\) \|\| `\$\{config\.project\.prefix\}-traefik`/);
    expect(src).toContain("app.set('trust proxy', proxyTrust.setting);");
    expect(src).toContain('app.use(proxyTrust.flagUntrustedForwarding);');
  });
});
