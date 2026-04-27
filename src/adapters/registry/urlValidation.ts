import * as dns from 'dns';
import { promisify } from 'util';

const dnsResolve = promisify(dns.resolve4);

/** Block requests to private/internal IP ranges */
export function isPrivateIP(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return true; // Block non-IPv4 as a precaution
  // 10.0.0.0/8
  if (parts[0] === 10) return true;
  // 172.16.0.0/12
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  // 192.168.0.0/16
  if (parts[0] === 192 && parts[1] === 168) return true;
  // 127.0.0.0/8 (loopback)
  if (parts[0] === 127) return true;
  // 169.254.0.0/16 (link-local)
  if (parts[0] === 169 && parts[1] === 254) return true;
  // 0.0.0.0
  if (parts.every((p) => p === 0)) return true;
  return false;
}

/**
 * Validate a registry/API URL is not targeting internal/private addresses.
 *
 * Set `OVERWATCH_ALLOW_PRIVATE_REGISTRY_URL=1` to opt out — necessary when
 * Overwatch and the registry/API host share a private network on purpose
 * (self-hosted GitLab/Harbor on a LAN, for example). Without the opt-out,
 * `localhost`, RFC1918 ranges, link-local, loopback, and the GCE metadata
 * host are all refused.
 *
 * Accepts either a full URL (`https://gitlab.acme.com:8080`) or a bare host
 * (`gitlab.acme.com`).
 */
export async function validateRegistryUrl(url: string): Promise<void> {
  if (process.env.OVERWATCH_ALLOW_PRIVATE_REGISTRY_URL === '1') return;

  let hostname: string;
  try {
    hostname = new URL(url.includes('://') ? url : `https://${url}`).hostname;
  } catch {
    // Fall back to the legacy parser (host:port/path style).
    hostname = url.split(':')[0].split('/')[0];
  }

  // Block obvious internal hostnames
  const blocked = ['localhost', '127.0.0.1', '0.0.0.0', '::1', 'metadata.google.internal'];
  if (blocked.includes(hostname.toLowerCase())) {
    throw new Error(`Registry URL points to blocked address: ${hostname}`);
  }

  // Resolve DNS and check if it points to a private IP
  try {
    const addresses = await dnsResolve(hostname);
    for (const addr of addresses) {
      if (isPrivateIP(addr)) {
        throw new Error(`Registry URL '${hostname}' resolves to private IP: ${addr}`);
      }
    }
  } catch (err: any) {
    if (err.message?.includes('resolves to private') || err.message?.includes('blocked address')) {
      throw err;
    }
    // DNS resolution failed — may be an IP address directly
    if (isPrivateIP(hostname)) {
      throw new Error(`Registry URL points to private IP: ${hostname}`);
    }
  }
}
