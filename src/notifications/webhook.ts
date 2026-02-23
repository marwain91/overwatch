import http from 'http';
import https from 'https';
import { URL } from 'url';
import dns from 'dns';
import { promisify } from 'util';
import net from 'net';
import { NotificationChannel, AlertHistoryEntry } from './types';

const dnsLookup = promisify(dns.lookup);

/** Block requests to private/internal IP ranges to prevent SSRF */
function isPrivateIP(ip: string): boolean {
  // Normalize IPv4-mapped IPv6 (::ffff:127.0.0.1 -> 127.0.0.1)
  const normalized = ip.replace(/^::ffff:/, '');

  if (!net.isIP(normalized)) return true; // treat invalid IPs as private

  const parts = normalized.split('.').map(Number);
  if (parts.length === 4) {
    // IPv4 checks
    if (parts[0] === 127) return true;                                   // 127.0.0.0/8 loopback
    if (parts[0] === 10) return true;                                    // 10.0.0.0/8
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
    if (parts[0] === 192 && parts[1] === 168) return true;              // 192.168.0.0/16
    if (parts[0] === 169 && parts[1] === 254) return true;              // 169.254.0.0/16 link-local/metadata
    if (parts[0] === 0) return true;                                     // 0.0.0.0/8
  }

  // IPv6 checks
  if (normalized === '::1') return true;                              // loopback
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // fc00::/7 unique local
  if (normalized.startsWith('fe80')) return true;                     // fe80::/10 link-local
  if (normalized === '::') return true;                               // unspecified

  return false;
}

/** Validate webhook URL and return the resolved IP to use for the request (prevents DNS rebinding) */
async function validateWebhookUrl(url: string): Promise<string | null> {
  const parsed = new URL(url);

  // Only allow http/https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Webhook URL must use http or https');
  }

  // Block localhost and common internal hostnames
  const hostname = parsed.hostname.toLowerCase();
  const blockedHostnames = ['localhost', 'metadata.google.internal', 'host.docker.internal', 'gateway.docker.internal'];
  if (blockedHostnames.includes(hostname) || hostname.endsWith('.internal')) {
    throw new Error('Webhook URL cannot point to localhost or internal services');
  }

  // Resolve hostname and check if it points to a private IP
  // Return the resolved IP so the caller can connect to it directly (prevents DNS rebinding)
  try {
    const { address } = await dnsLookup(hostname);
    if (isPrivateIP(address)) {
      throw new Error('Webhook URL resolves to a private/internal IP address');
    }
    return address;
  } catch (err: any) {
    if (err.message.includes('private') || err.message.includes('internal') || err.message.includes('localhost')) {
      throw err;
    }
    // DNS resolution failure — allow with hostname fallback (might be temporary)
    return null;
  }
}

export async function sendWebhook(channel: NotificationChannel, alert: AlertHistoryEntry): Promise<void> {
  const { url, headers = {}, method = 'POST' } = channel.config;

  // Validate URL and get resolved IP (prevents DNS rebinding)
  const resolvedIP = await validateWebhookUrl(url);

  const payload = JSON.stringify({
    alert: {
      id: alert.id,
      ruleId: alert.ruleId,
      ruleName: alert.ruleName,
      severity: alert.severity,
      message: alert.message,
      tenantId: alert.tenantId,
      containerName: alert.containerName,
      firedAt: alert.firedAt,
      resolvedAt: alert.resolvedAt,
    },
    channel: {
      id: channel.id,
      name: channel.name,
    },
    timestamp: new Date().toISOString(),
  });

  const attempt = async (): Promise<void> => {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const transport = parsedUrl.protocol === 'https:' ? https : http;

      const req = transport.request(
        {
          // Use resolved IP to prevent DNS rebinding; fall back to hostname if resolution failed
          hostname: resolvedIP || parsedUrl.hostname,
          port: parsedUrl.port,
          path: parsedUrl.pathname + parsedUrl.search,
          method,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            // Set Host header for correct virtual host routing when using resolved IP
            'Host': parsedUrl.host,
            ...headers,
          },
          // servername for TLS SNI when connecting by IP
          ...(resolvedIP && parsedUrl.protocol === 'https:' ? { servername: parsedUrl.hostname } : {}),
          timeout: 10_000,
        },
        (res) => {
          res.resume();
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Webhook returned ${res.statusCode}`));
          }
        }
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Webhook request timed out'));
      });

      req.write(payload);
      req.end();
    });
  };

  try {
    await attempt();
  } catch (firstError) {
    // Retry once
    try {
      await attempt();
    } catch (retryError) {
      console.error(`[Webhook] Failed to send to ${channel.name}: ${(retryError as Error).message}`);
    }
  }
}
