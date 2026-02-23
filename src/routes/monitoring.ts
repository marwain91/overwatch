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

// GET /api/monitoring/metrics — current + history for all containers
router.get('/metrics', asyncHandler(async (req, res) => {
  const appId = req.query.appId as string | undefined;
  const data = getMetrics(appId);
  res.json(data);
}));

// GET /api/monitoring/metrics/:tenantId — metrics for specific tenant
router.get('/metrics/:appId/:tenantId', asyncHandler(async (req, res) => {
  const { appId, tenantId } = req.params;
  const data = getMetrics(appId, tenantId);
  res.json(data);
}));

// GET /api/monitoring/metrics/history/:containerName — history for a container
router.get('/metrics/history/:containerName', asyncHandler(async (req, res) => {
  const { containerName } = req.params;
  const history = getMetricsHistory(containerName);
  res.json(history);
}));

// GET /api/monitoring/health — all health check states
router.get('/health', asyncHandler(async (req, res) => {
  const appId = req.query.appId as string | undefined;
  const states = getHealthStates();
  const filtered = appId ? states.filter(s => (s as any).appId === appId) : states;
  res.json(filtered);
}));

// GET /api/monitoring/alerts — alert history (paginated)
router.get('/alerts', asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
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
  const { name, type, enabled, config: channelConfig } = req.body;

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
