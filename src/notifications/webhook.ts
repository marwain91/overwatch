import http from 'http';
import https from 'https';
import { URL } from 'url';
import net from 'net';
import { assertPublicUrl } from '../utils/ssrf';
import { NotificationChannel, AlertHistoryEntry } from './types';

export async function sendWebhook(channel: NotificationChannel, alert: AlertHistoryEntry): Promise<void> {
  const { url, headers = {}, method = 'POST' } = channel.config;

  // Validate the URL and pin the connection to a validated address (prevents DNS rebinding)
  const [resolvedIP] = await assertPublicUrl(url, {
    allowPrivateEnv: 'OVERWATCH_ALLOW_PRIVATE_WEBHOOK',
    label: 'Webhook URL',
  });
  // The pinned address and Host come from the validated URL; a user header must not redirect virtual-host routing.
  const userHeaders = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'host'));

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
          // Connect to the validated address, not the name, to prevent DNS rebinding
          hostname: resolvedIP,
          port: parsedUrl.port,
          path: parsedUrl.pathname + parsedUrl.search,
          method,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            ...userHeaders,
            // Set last so it cannot be overridden
            'Host': parsedUrl.host,
          },
          // servername for TLS SNI when connecting by IP
          ...(parsedUrl.protocol === 'https:' && !net.isIP(parsedUrl.hostname.replace(/^\[|\]$/g, '')) ? { servername: parsedUrl.hostname } : {}),
          timeout: 10_000,
        },
        (res) => {
          res.resume();
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
            // Never follow: the target could bounce us to an internal address.
            reject(new Error(`Webhook returned ${res.statusCode} (redirects are not followed)`));
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
  } catch {
    // Retry once
    try {
      await attempt();
    } catch (retryError) {
      // Callers decide what to do: the test endpoint reports it, alert dispatch logs it.
      throw retryError;
    }
  }
}
