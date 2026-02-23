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

const router = Router();

const ID_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
const CONTAINER_NAME_RE = /^[a-z0-9][a-z0-9_.-]*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isValidWebhookUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'Webhook URL must use http or https';
    }
    return null;
  } catch {
    return 'Invalid webhook URL';
  }
}

// GET /api/monitoring/metrics — current + history for all containers
router.get('/metrics', asyncHandler(async (req, res) => {
  const appId = req.query.appId as string | undefined;
  if (appId && !ID_RE.test(appId)) {
    return res.status(400).json({ error: 'Invalid app ID format' });
  }
  const data = getMetrics(appId);
  res.json(data);
}));

// GET /api/monitoring/metrics/:tenantId — metrics for specific tenant
router.get('/metrics/:appId/:tenantId', asyncHandler(async (req, res) => {
  const { appId, tenantId } = req.params;
  if (!ID_RE.test(appId) || !ID_RE.test(tenantId)) {
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
  const appId = req.query.appId as string | undefined;
  if (appId && !ID_RE.test(appId)) {
    return res.status(400).json({ error: 'Invalid app ID format' });
  }
  const states = getHealthStates();
  const filtered = appId ? states.filter(s => (s as any).appId === appId) : states;
  res.json(filtered);
}));

// GET /api/monitoring/alerts — alert history (paginated)
router.get('/alerts', asyncHandler(async (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.query.limit as string) || 50, 500));
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

// POST /api/monitoring/notifications — add channel
router.post('/notifications', asyncHandler(async (req, res) => {
  const { name, type, enabled, config: channelConfig } = req.body;

  if (!name || !channelConfig?.url) {
    res.status(400).json({ error: 'Name and URL are required' });
    return;
  }

  // Validate URL format
  try {
    const parsed = new URL(channelConfig.url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      res.status(400).json({ error: 'Webhook URL must use http or https' });
      return;
    }
  } catch {
    res.status(400).json({ error: 'Invalid webhook URL' });
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

// PUT /api/monitoring/notifications/:id — update channel
router.put('/notifications/:id', asyncHandler(async (req, res) => {
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

// DELETE /api/monitoring/notifications/:id — delete channel
router.delete('/notifications/:id', asyncHandler(async (req, res) => {
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

// POST /api/monitoring/notifications/:id/test — send test notification
router.post('/notifications/:id/test', asyncHandler(async (req, res) => {
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
