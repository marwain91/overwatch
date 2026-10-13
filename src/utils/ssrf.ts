import dns from 'dns';
import net from 'net';
import { ValidationError } from './httpErrors';

function isPrivateIPv4(parts: number[]): boolean {
  const [a, b] = parts;
  if (a === 0) return true;                              // 0.0.0.0/8 "this network"
  if (a === 10) return true;                             // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true;     // 100.64.0.0/10 CGNAT
  if (a === 127) return true;                            // loopback
  if (a === 169 && b === 254) return true;               // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;      // 172.16.0.0/12
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24 IETF protocol
  if (a === 192 && b === 168) return true;               // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true;  // 198.18.0.0/15 benchmarking
  return a >= 224;                                       // multicast, reserved, broadcast
}

/** Expand an IPv6 literal to eight 16-bit groups, or null if it is malformed. */
function parseIPv6(ip: string): number[] | null {
  let text = ip;
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const octets = dotted[1].split('.').map(Number);
    if (octets.some(o => o > 255)) return null;
    text = text.slice(0, -dotted[1].length) +
      ((octets[0] << 8) | octets[1]).toString(16) + ':' + ((octets[2] << 8) | octets[3]).toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const nums = groups.map(g => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  return nums.length === 8 && nums.every(n => !Number.isNaN(n)) ? nums : null;
}

/**
 * True when an address must not be reached from a user-supplied URL: private,
 * loopback, link-local, CGNAT, multicast/reserved, unique-local and IPv4
 * addresses embedded in IPv6 (::ffff:a.b.c.d, 64:ff9b::/96). Anything that
 * does not parse as an IP counts as private (fail closed).
 */
export function isPrivateAddress(ip: string): boolean {
  const addr = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = net.isIP(addr);
  if (family === 4) return isPrivateIPv4(addr.split('.').map(Number));
  if (family !== 6) return true;
  const g = parseIPv6(addr);
  if (!g) return true;
  const embeddedV4 = [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff];
  if (g.slice(0, 5).every(n => n === 0) && g[5] === 0xffff) return isPrivateIPv4(embeddedV4); // ::ffff:0:0/96
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(n => n === 0)) return isPrivateIPv4(embeddedV4); // NAT64
  if (g.every(n => n === 0)) return true;                // ::
  if (g.slice(0, 7).every(n => n === 0) && g[7] === 1) return true; // ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true;           // fc00::/7 unique-local
  if ((g[0] & 0xffc0) === 0xfe80) return true;           // fe80::/10 link-local
  return (g[0] & 0xff00) === 0xff00;                     // ff00::/8 multicast
}

const BLOCKED_HOSTNAMES = ['localhost', 'host.docker.internal', 'gateway.docker.internal'];

export interface PublicUrlOptions {
  /** Name of an env var that, when `1`, skips the address checks (the scheme check always applies). */
  allowPrivateEnv?: string;
  /** Noun used in error messages. */
  label?: string;
}

/**
 * Refuse a URL that is not http(s) or that targets a private address. The
 * hostname is resolved (A and AAAA, as the OS resolver would) and every
 * returned address must be public. Returns the addresses so callers can pin
 * the connection to one. This checks at validation time only; callers that
 * need rebinding resistance must connect to a returned address.
 */
export async function assertPublicUrl(url: string, options: PublicUrlOptions = {}): Promise<string[]> {
  const label = options.label ?? 'URL';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError(`Invalid ${label}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError(`${label} must use http or https`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const allowPrivate = !!options.allowPrivateEnv && process.env[options.allowPrivateEnv] === '1';
  const refuse = (detail: string) => new ValidationError(`${label} points to a private/internal address (${detail})`);

  if (net.isIP(host)) {
    if (!allowPrivate && isPrivateAddress(host)) throw refuse(host);
    return [host];
  }
  if (!allowPrivate && (BLOCKED_HOSTNAMES.includes(host) || host.endsWith('.localhost') || host.endsWith('.internal'))) {
    throw refuse(host);
  }

  let addresses: string[];
  try {
    addresses = (await dns.promises.lookup(host, { all: true })).map(a => a.address);
  } catch {
    throw new ValidationError(`${label} host '${host}' could not be resolved`);
  }
  if (addresses.length === 0) throw new ValidationError(`${label} host '${host}' could not be resolved`);
  if (!allowPrivate) {
    const bad = addresses.find(isPrivateAddress);
    if (bad) throw refuse(`'${host}' resolves to ${bad}`);
  }
  return addresses;
}
