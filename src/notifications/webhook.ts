import http from 'http';
import https from 'https';
import { URL } from 'url';
import { NotificationChannel, AlertHistoryEntry } from './types';

export async function sendWebhook(channel: NotificationChannel, alert: AlertHistoryEntry): Promise<void> {
  const { url, headers = {}, method = 'POST' } = channel.config;

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
          hostname: parsedUrl.hostname,
          port: parsedUrl.port,
          path: parsedUrl.pathname + parsedUrl.search,
          method,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            ...headers,
          },
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
