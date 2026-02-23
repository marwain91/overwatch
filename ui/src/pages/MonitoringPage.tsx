import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { useMetrics, useHealthStates, useAlertHistory, useNotificationChannels, useCreateNotification, useUpdateNotification, useDeleteNotification, useTestNotification } from '../hooks/useMonitoring';
import { useWSStore } from '../stores/wsStore';
import { formatBytes } from '../lib/format';
import { cn } from '../lib/cn';
import { Modal } from '../components/Modal';
import type { NotificationChannel } from '../lib/types';

export function MonitoringPage() {
  const { appId } = useParams<{ appId: string }>();
  const wsConnected = useWSStore((s) => s.connected);
  const wsMetrics = useWSStore((s) => s.latestMetrics);
  const { data: fetchedMetrics } = useMetrics(appId);
  const { data: healthStates } = useHealthStates(appId);
  const { data: alerts } = useAlertHistory();
  const { data: channels } = useNotificationChannels();

  const metrics = wsMetrics || fetchedMetrics;

  const [metricsSearch, setMetricsSearch] = useState('');
  const [healthSearch, setHealthSearch] = useState('');
  const [showChannelModal, setShowChannelModal] = useState<NotificationChannel | 'new' | null>(null);

  // Filter metrics by app
  const appTenants = metrics?.tenants?.filter((t) => !appId || t.appId === appId) || [];
  const filteredTenants = appTenants.filter((t) => !metricsSearch || t.tenantId.includes(metricsSearch));

  const filteredHealth = (healthStates || []).filter((h) =>
    (!appId || h.appId === appId) && (!healthSearch || h.containerName.includes(healthSearch)),
  );

  const appAlerts = (alerts || []).slice(0, 50);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/* Metrics */}
      <section className="card">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-content-primary">Resource Metrics</h2>
          <div className="flex items-center gap-3">
            <span className={cn('badge', wsConnected ? 'badge-green' : 'badge-red')}>
              WS: {wsConnected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
        </div>
        <input
          className="input mb-4 max-w-xs"
          placeholder="Search tenants..."
          value={metricsSearch}
          onChange={(e) => setMetricsSearch(e.target.value)}
        />

        {filteredTenants.length > 0 ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {filteredTenants.map((tenant) => {
              const memPct = tenant.totalMemLimit > 0 ? (tenant.totalMem / tenant.totalMemLimit) * 100 : 0;
              const containers = metrics?.containers?.filter((c) => c.tenantId === tenant.tenantId && c.appId === (appId || c.appId)) || [];

              return (
                <div key={`${tenant.appId}-${tenant.tenantId}`} className="rounded-lg border border-border-subtle bg-surface-muted p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-content-secondary">{tenant.tenantId}</h3>
                    <span className="text-xs text-content-faint">{tenant.containerCount} containers</span>
                  </div>

                  {/* CPU bar */}
                  <div className="mb-2">
                    <div className="mb-1 flex justify-between text-xs text-content-muted">
                      <span>CPU</span>
                      <span>{tenant.totalCpu.toFixed(1)}%</span>
                    </div>
                    <div className="h-2 rounded-full bg-surface-subtle">
                      <div className="h-2 rounded-full bg-brand-500 transition-all" style={{ width: `${Math.min(tenant.totalCpu, 100)}%` }} />
                    </div>
                  </div>

                  {/* Memory bar */}
                  <div className="mb-3">
                    <div className="mb-1 flex justify-between text-xs text-content-muted">
                      <span>Memory</span>
                      <span>{formatBytes(tenant.totalMem)} / {formatBytes(tenant.totalMemLimit)}</span>
                    </div>
                    <div className="h-2 rounded-full bg-surface-subtle">
                      <div className="h-2 rounded-full bg-purple-500 transition-all" style={{ width: `${Math.min(memPct, 100)}%` }} />
                    </div>
                  </div>

                  {/* Per-container detail */}
                  <div className="space-y-1">
                    {containers.map((c) => (
                      <div key={c.containerName} className="flex justify-between text-xs text-content-faint">
                        <span>{c.service}</span>
                        <span>{c.cpuPercent.toFixed(1)}% / {formatBytes(c.memUsage)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-content-muted">No metrics available.</p>
        )}
      </section>

      {/* Health Checks */}
      <section className="card">
        <h2 className="mb-4 text-lg font-semibold text-content-primary">Health Checks</h2>
        <input
          className="input mb-4 max-w-xs"
          placeholder="Search containers..."
          value={healthSearch}
          onChange={(e) => setHealthSearch(e.target.value)}
        />
        {filteredHealth.length > 0 ? (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {filteredHealth.map((h) => (
              <div key={h.containerName} className={cn('rounded border px-3 py-2', h.state === 'healthy' ? 'border-green-800 bg-green-900/20' : h.state === 'unhealthy' ? 'border-red-800 bg-red-900/20' : 'border-border-subtle bg-surface-muted')}>
                <p className="text-sm text-content-secondary">{h.containerName}</p>
                <p className="text-xs text-content-faint">
                  {h.state} {h.lastCheck && `— ${new Date(h.lastCheck).toLocaleTimeString()}`}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-content-muted">No health check data.</p>
        )}
      </section>

      {/* Alert History */}
      <section className="card">
        <h2 className="mb-4 text-lg font-semibold text-content-primary">Alert History</h2>
        {appAlerts.length > 0 ? (
          <div className="space-y-2">
            {appAlerts.map((a) => (
              <div key={a.id || a.firedAt} className="flex items-center justify-between rounded border border-border-subtle bg-surface-muted px-3 py-2">
                <div>
                  <p className="text-sm text-content-secondary">{a.ruleName}</p>
                  <p className="text-xs text-content-faint">{a.message}</p>
                  <p className="text-xs text-content-fainter">{new Date(a.firedAt).toLocaleString()}</p>
                </div>
                <span className={cn('badge', a.severity === 'critical' ? 'badge-red' : a.severity === 'warning' ? 'badge-yellow' : 'badge-blue')}>
                  {a.severity}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-content-muted">No alerts recorded.</p>
        )}
      </section>

      {/* Notification Channels */}
      <section className="card">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-content-primary">Notification Channels</h2>
          <button className="btn btn-primary btn-sm" onClick={() => setShowChannelModal('new')}>
            + Add Webhook
          </button>
        </div>
        {channels && channels.length > 0 ? (
          <div className="space-y-2">
            {channels.map((ch) => (
              <ChannelRow key={ch.id} channel={ch} onEdit={() => setShowChannelModal(ch)} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-content-muted">No notification channels configured.</p>
        )}
      </section>

      {showChannelModal && (
        <ChannelModal
          channel={showChannelModal === 'new' ? null : showChannelModal}
          onClose={() => setShowChannelModal(null)}
        />
      )}
    </div>
  );
}

function ChannelRow({ channel, onEdit }: { channel: NotificationChannel; onEdit: () => void }) {
  const deleteChannel = useDeleteNotification();
  const testChannel = useTestNotification();

  return (
    <div className="flex items-center justify-between rounded border border-border-subtle bg-surface-muted px-3 py-2">
      <div>
        <p className="text-sm text-content-secondary">{channel.name}</p>
        <p className="text-xs text-content-faint">{channel.config?.url}</p>
      </div>
      <div className="flex items-center gap-2">
        <span className={cn('badge', channel.enabled ? 'badge-green' : 'badge-gray')}>
          {channel.enabled ? 'Enabled' : 'Disabled'}
        </span>
        <button className="btn btn-secondary btn-xs" onClick={() => testChannel.mutate(channel.id, {
          onSuccess: () => toast.success('Test sent'),
          onError: (err) => toast.error(err.message),
        })}>Test</button>
        <button className="btn btn-secondary btn-xs" onClick={onEdit}>Edit</button>
        <button className="btn btn-danger btn-xs" onClick={() => deleteChannel.mutate(channel.id, {
          onSuccess: () => toast.success('Channel deleted'),
          onError: (err) => toast.error(err.message),
        })}>Delete</button>
      </div>
    </div>
  );
}

function ChannelModal({ channel, onClose }: { channel: NotificationChannel | null; onClose: () => void }) {
  const create = useCreateNotification();
  const update = useUpdateNotification();
  const [name, setName] = useState(channel?.name || '');
  const [url, setUrl] = useState(channel?.config?.url || '');
  const [enabled, setEnabled] = useState(channel?.enabled ?? true);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const data = { name, type: 'webhook' as const, enabled, config: { url } };

    if (channel) {
      update.mutate({ id: channel.id, ...data }, {
        onSuccess: () => { toast.success('Channel updated'); onClose(); },
        onError: (err) => toast.error(err.message),
      });
    } else {
      create.mutate(data, {
        onSuccess: () => { toast.success('Channel added'); onClose(); },
        onError: (err) => toast.error(err.message),
      });
    }
  };

  return (
    <Modal title={`${channel ? 'Edit' : 'Add'} Webhook`} size="md" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="label">Name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div>
          <label className="label">Webhook URL</label>
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} required />
        </div>
        <label className="flex items-center gap-2 text-sm text-content-tertiary">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={create.isPending || update.isPending}>Save</button>
        </div>
      </form>
    </Modal>
  );
}
