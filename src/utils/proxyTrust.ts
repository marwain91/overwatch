import { promises as dns } from 'dns';
import type { IncomingMessage } from 'http';
import type { Request, Response, NextFunction } from 'express';

export type TrustProxySetting = boolean | number | string;
/** Express/proxy-addr trust function: may the address at hop `i` (0 = socket peer) set X-Forwarded-*? */
export type TrustFn = (addr: string, i: number) => boolean;

// Default: trust exactly one upstream hop. Matches the intended deployment
// (Traefik in front of Overwatch on the same Docker network). index.ts pins
// that hop to Traefik's address (pinTrustToProxyHost), because every tenant
// container shares the network and could otherwise spoof X-Forwarded-For.
const DEFAULT_TRUST_PROXY = 1;

export function resolveTrustProxySetting(env: { OVERWATCH_TRUST_PROXY?: string } = process.env): TrustProxySetting {
  const raw = env.OVERWATCH_TRUST_PROXY?.trim();
  if (!raw) return DEFAULT_TRUST_PROXY;

  const lower = raw.toLowerCase();
  if (['0', 'false', 'off', 'no', 'none'].includes(lower)) {
    return false;
  }
  if (lower === '1') {
    return 1;
  }
  if (['true', 'on', 'yes'].includes(lower)) {
    return true;
  }

  const numeric = Number(raw);
  if (Number.isInteger(numeric) && numeric >= 0) {
    return numeric;
  }

  return raw;
}

const DISABLED_HOSTS = new Set(['none', 'off', 'false', '0']);
const REFRESH_MS = 30_000;
const LOOKUP_TIMEOUT_MS = 2_000;
const UNTRUSTED_REFRESH_MIN_MS = 5_000;
const UNTRUSTED_WARN_EVERY_MS = 10 * 60_000;
const UNTRUSTED_WARN_MAX_PEERS = 1_000;

function normaliseAddr(addr: string): string {
  const lower = addr.toLowerCase();
  return lower.startsWith('::ffff:') && lower.includes('.') ? lower.slice(7) : lower;
}

async function defaultLookup(host: string): Promise<string[]> {
  const found = await dns.lookup(host, { all: true });
  return found.map(a => a.address);
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export interface PinnedProxyTrust {
  /** Value for app.set('trust proxy', ...). */
  setting: TrustProxySetting | TrustFn;
  /** Re-resolve the proxy host now. */
  refresh(): Promise<void>;
  /** Warns (throttled) about X-Forwarded-For from a peer that is not the proxy, and re-resolves the proxy. */
  flagUntrustedForwarding(req: Request, res: Response, next: NextFunction): void;
  stop(): void;
}

export interface PinOptions {
  /** DNS name of the reverse proxy (the Traefik container). 'none' keeps the hop count unpinned. */
  host: string;
  lookup?: (host: string) => Promise<string[]>;
  refreshMs?: number;
  lookupTimeoutMs?: number;
  log?: { warn: (msg: string) => void; info: (msg: string) => void };
}

/**
 * A hop count trusts X-Forwarded-For from whichever peer connects, and every
 * tenant container shares the Docker network with Overwatch, so a tenant could
 * connect directly and claim any client IP (per-IP rate limits, audit IPs).
 * For a hop-count setting this pins the first hop to the proxy's resolved
 * addresses, re-resolved periodically. Until the proxy resolves it keeps the
 * plain hop count, with a warning, rather than keying every request by the
 * proxy's address (which would put all admins in one rate-limit bucket).
 * Explicit address lists, true and false are returned unchanged.
 */
export async function pinTrustToProxyHost(setting: TrustProxySetting, opts: PinOptions): Promise<PinnedProxyTrust> {
  const passthrough = (_req: Request, _res: Response, next: NextFunction) => next();
  const log = opts.log ?? { warn: (m: string) => console.warn(m), info: (m: string) => console.log(m) };
  const host = opts.host.trim();
  if (typeof setting !== 'number' || setting < 1 || !host || DISABLED_HOSTS.has(host.toLowerCase())) {
    return { setting, refresh: async () => {}, flagUntrustedForwarding: passthrough, stop: () => {} };
  }

  const hops = setting;
  const lookup = opts.lookup ?? defaultLookup;
  const timeoutMs = opts.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS;
  const refreshMs = opts.refreshMs ?? REFRESH_MS;
  let proxyAddrs = new Set<string>();
  let failing = false;

  const refresh = async (): Promise<void> => {
    let addrs: string[];
    try {
      addrs = (await withTimeout(lookup(host), timeoutMs)).map(normaliseAddr);
      if (addrs.length === 0) throw new Error('no addresses');
    } catch (err: any) {
      if (!failing) {
        failing = true;
        if (proxyAddrs.size === 0) {
          log.warn(`[proxy-trust] WARNING: cannot resolve the reverse proxy '${host}' (${err?.message || err}). ` +
            `X-Forwarded-For is trusted from ANY peer ${hops} hop(s) away, so a container on a shared Docker network can spoof client IPs. ` +
            `Retrying every ${Math.round(refreshMs / 1000)}s. Set OVERWATCH_TRUST_PROXY_HOST to the proxy's DNS name, ` +
            `or OVERWATCH_TRUST_PROXY to its IP/CIDR.`);
        } else {
          log.warn(`[proxy-trust] Re-resolving '${host}' failed (${err?.message || err}); keeping ${[...proxyAddrs].join(', ')}.`);
        }
      }
      return;
    }
    failing = false;
    const next = new Set(addrs);
    const changed = next.size !== proxyAddrs.size || [...next].some(a => !proxyAddrs.has(a));
    proxyAddrs = next;
    if (changed) {
      log.info(`[proxy-trust] X-Forwarded-For trusted only from '${host}' (${[...next].join(', ')}).`);
      if (next.size > 1) log.warn(`[proxy-trust] '${host}' resolves to ${next.size} addresses; check that no other container claims that name.`);
    }
  };

  const trust: TrustFn = (addr, i) => {
    if (i >= hops) return false;
    if (i > 0 || proxyAddrs.size === 0) return true;
    return proxyAddrs.has(normaliseAddr(addr));
  };

  await refresh();
  const timer = setInterval(() => { void refresh(); }, refreshMs);
  timer.unref();

  let lastUntrustedRefresh = 0;
  const warnedAt = new Map<string, number>();
  const flagUntrustedForwarding = (req: Request, _res: Response, next: NextFunction) => {
    const peer = req.socket.remoteAddress;
    if (peer && req.headers['x-forwarded-for'] !== undefined && !trust(peer, 0)) {
      const now = Date.now();
      // The proxy may have restarted with a new address; don't wait for the next tick.
      if (now - lastUntrustedRefresh >= UNTRUSTED_REFRESH_MIN_MS) {
        lastUntrustedRefresh = now;
        void refresh();
      }
      const last = warnedAt.get(peer);
      if (last === undefined || now - last >= UNTRUSTED_WARN_EVERY_MS) {
        if (warnedAt.size >= UNTRUSTED_WARN_MAX_PEERS) warnedAt.clear();
        warnedAt.set(peer, now);
        log.warn(`[proxy-trust] Ignoring X-Forwarded-For from ${peer}: it is not '${host}' (${[...proxyAddrs].join(', ')}). ` +
          `If ${peer} is your reverse proxy, set OVERWATCH_TRUST_PROXY to its IP/CIDR or OVERWATCH_TRUST_PROXY_HOST to its DNS name.`);
      }
    }
    next();
  };

  return { setting: trust, refresh, flagUntrustedForwarding, stop: () => clearInterval(timer) };
}

/**
 * The client address for a raw upgrade request, resolved exactly like
 * Express's req.ip (proxy-addr): walk from the socket peer outwards through
 * X-Forwarded-For and stop at the first address the trust function rejects.
 */
export function clientIpOf(req: IncomingMessage, trust: TrustFn): string {
  const header = req.headers['x-forwarded-for'];
  const forwarded = (Array.isArray(header) ? header.join(',') : header ?? '')
    .split(',').map(s => s.trim()).filter(Boolean).reverse();
  const addrs = [req.socket.remoteAddress ?? '', ...forwarded];
  for (let i = 0; i < addrs.length - 1; i++) {
    if (!trust(addrs[i], i)) return addrs[i];
  }
  return addrs[addrs.length - 1];
}
