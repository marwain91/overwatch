import { Router } from 'express';
import { randomUUID } from 'crypto';
import { asyncHandler } from '../utils/asyncHandler';
import { getMetrics, getMetricsHistory } from '../services/metricsCollector';
import { getHealthStates } from '../services/healthChecker';
import {
  getAlertHistory,
  getNotificationChannelsData,
  updateNotificationChannels,
  sendTestNotification,
} from '../services/alertEngine';
import type { NotificationChannel } from '../notifications/types';
import { loadConfig } from '../config';
import { SLUG_RE, CONTAINER_NAME_RE, UUID_RE } from '../utils/validators';
import { queryString, queryInt } from '../utils/query';
import { requireRole } from '../middleware/requireRole';
import { assertPublicUrl } from '../utils/ssrf';
import { NotFoundError, ValidationError } from '../utils/httpErrors';

const router = Router();

// SSRF guard for webhook URLs (shared with the send path). Escape hatch for
// on-prem setups that route alerts to an internal collector:
// OVERWATCH_ALLOW_PRIVATE_WEBHOOK=1.
export async function webhookUrlError(url: unknown): Promise<string | null> {
  if (typeof url !== 'string') return 'Invalid webhook URL';
  try {
    await assertPublicUrl(url, { allowPrivateEnv: 'OVERWATCH_ALLOW_PRIVATE_WEBHOOK', label: 'Webhook URL' });
    return null;
  } catch (err) {
    if (err instanceof ValidationError) return err.message;
    throw err;
  }
}

// GET /api/monitoring/metrics — current + history for all containers
router.get('/metrics', asyncHandler(async (req, res) => {
  const appId = queryString(req.query.appId);
  if (appId && !SLUG_RE.test(appId)) {
    return res.status(400).json({ error: 'Invalid app ID format' });
  }
  const data = getMetrics(appId);
  res.json(data);
}));

// GET /api/monitoring/metrics/:tenantId — metrics for specific tenant
router.get('/metrics/:appId/:tenantId', asyncHandler(async (req, res) => {
  const { appId, tenantId } = (req.params as Record<string, string>);
  if (!SLUG_RE.test(appId) || !SLUG_RE.test(tenantId)) {
    return res.status(400).json({ error: 'Invalid app or tenant ID format' });
  }
  const data = getMetrics(appId, tenantId);
  res.json(data);
}));

// GET /api/monitoring/metrics/history/:containerName — history for a container
router.get('/metrics/history/:containerName', asyncHandler(async (req, res) => {
  const { containerName } = (req.params as Record<string, string>);
  if (!CONTAINER_NAME_RE.test(containerName) || containerName.length > 200) {
    return res.status(400).json({ error: 'Invalid container name format' });
  }
  const history = getMetricsHistory(containerName);
  res.json(history);
}));

// GET /api/monitoring/health — all health check states
router.get('/health', asyncHandler(async (req, res) => {
  const appId = queryString(req.query.appId);
  if (appId && !SLUG_RE.test(appId)) {
    return res.status(400).json({ error: 'Invalid app ID format' });
  }
  const states = getHealthStates();
  const filtered = appId ? states.filter(s => (s as any).appId === appId) : states;
  res.json(filtered);
}));

// GET /api/monitoring/alerts — alert history (paginated)
router.get('/alerts', asyncHandler(async (req, res) => {
  const limit = queryInt(req.query.limit, 50, 1, 500);
  const history = await getAlertHistory(limit);
  res.json(history);
}));

// GET /api/monitoring/alerts/rules — configured rules (from config)
router.get('/alerts/rules', asyncHandler(async (_req, res) => {
  const config = loadConfig();
  res.json(config.alert_rules ?? []);
}));

const MASK = '••••••••';

/**
 * Keep only the scheme: Slack/Discord-style webhook URLs carry their secret in
 * the path, and some services (e.g. per-endpoint subdomains) in the host.
 */
function redactWebhookUrl(url: string): string {
  try {
    return `${new URL(url).protocol}//${MASK}`;
  } catch {
    return MASK;
  }
}

// GET /api/monitoring/notifications — list notification channels. Webhook URLs
// and custom headers (e.g. Authorization) are credentials, so only admins — the
// only role that can edit channels — get them unredacted.
router.get('/notifications', asyncHandler(async (_req, res) => {
  const channels = await getNotificationChannelsData();
  // Role was resolved once by authMiddleware. Explicit check: can(undefined, ...)
  // treats a missing role as legacy admin, which would fail open.
  if (res.locals.user?.role === 'admin') {
    res.json(channels);
    return;
  }
  res.json(channels.map(c => ({
    ...c,
    config: {
      ...c.config,
      url: redactWebhookUrl(c.config.url),
      headers: c.config.headers
        ? Object.fromEntries(Object.keys(c.config.headers).map(k => [k, MASK]))
        : undefined,
    },
  })));
}));

// POST /api/monitoring/notifications — add channel (admin-only: webhooks can exfiltrate)
router.post('/notifications', requireRole('admin'), asyncHandler(async (req, res) => {
  const { name, type, enabled, config: channelConfig } = req.body;

  if (!name || !channelConfig?.url) {
    res.status(400).json({ error: 'Name and URL are required' });
    return;
  }

  const urlError = await webhookUrlError(channelConfig.url);
  if (urlError) {
    res.status(400).json({ error: urlError });
    return;
  }

  const newChannel: NotificationChannel = {
    id: randomUUID(),
    name,
    type: type || 'webhook',
    enabled: enabled !== false,
    config: channelConfig,
  };
  await updateNotificationChannels((channels) => { channels.push(newChannel); });
  res.json(newChannel);
}));

// PUT /api/monitoring/notifications/:id — update channel (admin-only)
router.put('/notifications/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const { id } = (req.params as Record<string, string>);
  if (!UUID_RE.test(id)) {
    res.status(400).json({ error: 'Invalid channel ID format' });
    return;
  }
  const { name, type, enabled, config: channelConfig } = req.body;

  // Re-validate URL if config is being updated
  if (channelConfig?.url) {
    const urlError = await webhookUrlError(channelConfig.url);
    if (urlError) {
      res.status(400).json({ error: urlError });
      return;
    }
  }

  // The lookup and the edit run on the list read under the lock.
  const updated = await updateNotificationChannels((channels) => {
    const index = channels.findIndex(c => c.id === id);
    if (index === -1) throw new NotFoundError('Channel not found');
    channels[index] = {
      ...channels[index],
      name: name ?? channels[index].name,
      type: type ?? channels[index].type,
      enabled: enabled ?? channels[index].enabled,
      config: channelConfig ?? channels[index].config,
    };
    return channels[index];
  });
  res.json(updated);
}));

// DELETE /api/monitoring/notifications/:id — delete channel (admin-only)
router.delete('/notifications/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const { id } = (req.params as Record<string, string>);
  if (!UUID_RE.test(id)) {
    res.status(400).json({ error: 'Invalid channel ID format' });
    return;
  }
  await updateNotificationChannels((channels) => {
    const index = channels.findIndex(c => c.id === id);
    if (index === -1) throw new NotFoundError('Channel not found');
    channels.splice(index, 1);
  });
  res.json({ success: true });
}));

// POST /api/monitoring/notifications/:id/test — send test notification (admin-only: fires outbound HTTP to channel URL)
router.post('/notifications/:id/test', requireRole('admin'), asyncHandler(async (req, res) => {
  const { id } = (req.params as Record<string, string>);
  if (!UUID_RE.test(id)) {
    res.status(400).json({ error: 'Invalid channel ID format' });
    return;
  }
  const channels = await getNotificationChannelsData();
  const channel = channels.find(c => c.id === id);

  if (!channel) {
    res.status(404).json({ error: 'Channel not found' });
    return;
  }

  try {
    await sendTestNotification(channel);
  } catch (err: any) {
    res.status(502).json({ error: `Test notification failed: ${err?.message || 'delivery error'}` });
    return;
  }
  res.json({ success: true });
}));

export default router;
