import { spawnSync } from 'child_process';
import * as dns from 'dns';
import { promisify } from 'util';
import { RegistryAdapter, RegistryAdapterConfig } from './types';

const dnsResolve = promisify(dns.resolve4);

/** Block requests to private/internal IP ranges */
function isPrivateIP(ip: string): boolean {
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
  if (parts.every(p => p === 0)) return true;
  return false;
}

/** Validate registry URL is not targeting internal/private addresses */
async function validateRegistryUrl(url: string): Promise<void> {
  const hostname = url.split(':')[0].split('/')[0];

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

/**
 * Custom/self-hosted registry adapter
 * Works with any Docker V2 compatible registry
 */
export class CustomRegistryAdapter implements RegistryAdapter {
  private config: RegistryAdapterConfig;

  constructor(config: RegistryAdapterConfig) {
    this.config = config;
  }

  async login(): Promise<void> {
    if (!this.config.username || !this.config.token) {
      console.log('Custom registry credentials not configured, skipping login');
      return;
    }

    try {
      console.log(`Authenticating with custom registry ${this.config.url}...`);

      const result = spawnSync(
        'docker', ['login', this.config.url, '-u', this.config.username, '--password-stdin'],
        { input: this.config.token, stdio: ['pipe', 'pipe', 'pipe'] }
      );

      if (result.status !== 0) {
        throw new Error(result.stderr?.toString() || 'docker login failed');
      }

      console.log(`Successfully logged in to ${this.config.url}`);
    } catch (error) {
      console.error('Failed to login to custom registry:', error);
      throw error;
    }
  }

  async getImageTags(): Promise<string[]> {
    // For custom registries, we try the Docker Registry V2 API
    // This may not work for all registries
    try {
      // Validate URL to prevent SSRF attacks against internal services
      await validateRegistryUrl(this.config.url);

      const repoUrl = `https://${this.config.url}/v2/${this.config.repository}/tags/list`;
      const headers: Record<string, string> = {};

      if (this.config.username && this.config.token) {
        const auth = Buffer.from(`${this.config.username}:${this.config.token}`).toString('base64');
        headers['Authorization'] = `Basic ${auth}`;
      }

      const response = await fetch(repoUrl, { headers });

      if (!response.ok) {
        console.error('Custom registry API error:', response.status);
        return [];
      }

      const data = await response.json() as { tags: string[] };

      const pattern = this.config.tagPattern || /^v/;
      return (data.tags || [])
        .filter(name => pattern.test(name))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    } catch (error) {
      console.error('Failed to fetch tags from custom registry:', error);
      return [];
    }
  }

  getImageRef(service: string, tag: string): string {
    return `${this.config.url}/${this.config.repository}/${service}:${tag}`;
  }

  getType(): string {
    return 'custom';
  }
}
