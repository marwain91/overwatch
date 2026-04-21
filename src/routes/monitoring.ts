import { Router } from 'express';
import { randomUUID } from 'crypto';
import { asyncHandler } from '../utils/asyncHandler';
import { getMetrics, getMetricsHistory } from '../services/metricsCollector';
import { getHealthStates } from '../services/healthChecker';
import {
  getAlertHistory,
  getNotificationChannelsData,
  saveNotificationChannels,
  sendTestNotification,
} from '../services/alertEngine';
import { loadConfig } from '../config';
import { SLUG_RE, CONTAINER_NAME_RE, UUID_RE } from '../utils/validators';
import { queryString, queryInt } from '../utils/query';
import { requireRole } from '../middleware/requireRole';

const router = Router();

// SSRF guard for webhook URLs. Blocks loopback, private/link-local ranges, and
// the common cloud metadata endpoint (169.254.169.254). Escape hatch for
// on-prem setups that route alerts to an internal collector:
// OVERWATCH_ALLOW_PRIVATE_WEBHOOK=1.
export function isValidWebhookUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Invalid webhook URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'Webhook URL must use http or https';
  }
  if (process.env.OVERWATCH_ALLOW_PRIVATE_WEBHOOK === '1') {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') {
    return 'Webhook URL must not target localhost';
  }
  // IPv4 — numeric dotted-quad. Refuse if in loopback / private / link-local / reserved.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return 'Webhook URL must not target private network (10/8)';
    if (a === 127) return 'Webhook URL must not target loopback (127/8)';
    if (a === 169 && b === 254) return 'Webhook URL must not target link-local / metadata endpoint';
    if (a === 172 && b >= 16 && b <= 31) return 'Webhook URL must not target private network (172.16/12)';
    if (a === 192 && b === 168) return 'Webhook URL must not target private network (192.168/16)';
    if (a === 0) return 'Webhook URL must not target reserved range (0/8)';
    if (a >= 224) return 'Webhook URL must not target multicast/reserved range';
  }
  // IPv6 — any form of loopback / link-local / unique-local.
  if (host.includes(':')) {
    const stripped = host.replace(/^\[|\]$/g, '');
    if (stripped === '::1' || stripped === '::') {
      return 'Webhook URL must not target IPv6 loopback';
    }
    if (/^fe[89ab][0-9a-f]?:/i.test(stripped)) {
      return 'Webhook URL must not target IPv6 link-local (fe80::/10)';
    }
    if (/^f[cd][0-9a-f]{2}:/i.test(stripped)) {
      return 'Webhook URL must not target IPv6 unique-local (fc00::/7)';
    }
  }
  return null;
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
  const { appId, tenantId } = req.params;
  if (!SLUG_RE.test(appId) || !SLUG_RE.test(tenantId)) {
    return res.status(400).json({ error: 'Invalid app or tenant ID format' });
  }
  const data = getMetrics(appId, tenantId);
  res.json(data);
}));

// GET /api/monitoring/metrics/history/:containerName — history for a container
router.get('/metrics/history/:containerName', asyncHandler(async (req, res) => {
  const { containerName } = req.params;
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
router.get('/alerts/rules', asyncHandler(async (req, res) => {
  const config = loadConfig();
  res.json((config as any).alert_rules || []);
}));

// GET /api/monitoring/notifications — list notification channels
router.get('/notifications', asyncHandler(async (req, res) => {
  const channels = await getNotificationChannelsData();
  res.json(channels);
}));

// POST /api/monitoring/notifications — add channel (admin-only: webhooks can exfiltrate)
router.post('/notifications', requireRole('admin'), asyncHandler(async (req, res) => {
  const { name, type, enabled, config: channelConfig } = req.body;

  if (!name || !channelConfig?.url) {
    res.status(400).json({ error: 'Name and URL are required' });
    return;
  }

  const urlError = isValidWebhookUrl(channelConfig.url);
  if (urlError) {
    res.status(400).json({ error: urlError });
    return;
  }

  const channels = await getNotificationChannelsData();
  const newChannel = {
    id: randomUUID(),
    name,
    type: type || 'webhook',
    enabled: enabled !== false,
    config: channelConfig,
  };
  channels.push(newChannel);
  await saveNotificationChannels(channels);
  res.json(newChannel);
}));

// PUT /api/monitoring/notifications/:id — update channel (admin-only)
router.put('/notifications/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    res.status(400).json({ error: 'Invalid channel ID format' });
    return;
  }
  const { name, type, enabled, config: channelConfig } = req.body;

  // Re-validate URL if config is being updated
  if (channelConfig?.url) {
    const urlError = isValidWebhookUrl(channelConfig.url);
    if (urlError) {
      res.status(400).json({ error: urlError });
      return;
    }
  }

  const channels = await getNotificationChannelsData();
  const index = channels.findIndex(c => c.id === id);

  if (index === -1) {
    res.status(404).json({ error: 'Channel not found' });
    return;
  }

  channels[index] = {
    ...channels[index],
    name: name ?? channels[index].name,
    type: type ?? channels[index].type,
    enabled: enabled ?? channels[index].enabled,
    config: channelConfig ?? channels[index].config,
  };

  await saveNotificationChannels(channels);
  res.json(channels[index]);
}));

// DELETE /api/monitoring/notifications/:id — delete channel (admin-only)
router.delete('/notifications/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    res.status(400).json({ error: 'Invalid channel ID format' });
    return;
  }
  const channels = await getNotificationChannelsData();
  const filtered = channels.filter(c => c.id !== id);

  if (filtered.length === channels.length) {
    res.status(404).json({ error: 'Channel not found' });
    return;
  }

  await saveNotificationChannels(filtered);
  res.json({ success: true });
}));

// POST /api/monitoring/notifications/:id/test — send test notification (admin-only: fires outbound HTTP to channel URL)
router.post('/notifications/:id/test', requireRole('admin'), asyncHandler(async (req, res) => {
  const { id } = req.params;
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

  await sendTestNotification(channel);
  res.json({ success: true });
}));

export default router;
