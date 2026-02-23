import { useState, useRef, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { toast } from 'sonner';
import { useTenants, useTenantAction, useContainerLogs, useRestartContainer } from '../hooks/useTenants';
import { useWSStore } from '../stores/wsStore';
import { formatBytes, formatRelativeTime } from '../lib/format';
import { cn } from '../lib/cn';
import type { ContainerMetrics } from '../lib/types';

const TAIL_OPTIONS = [100, 200, 500, 1000] as const;

export function TenantDetailPage() {
  const { appId, tenantId } = useParams<{ appId: string; tenantId: string }>();
  const { data: tenants, isLoading } = useTenants(appId!);
  const tenant = tenants?.find((t) => t.tenantId === tenantId);

  const latestMetrics = useWSStore((s) => s.latestMetrics);
  const tenantMetrics = latestMetrics?.tenants?.find(
    (t) => t.tenantId === tenantId && t.appId === appId,
  );
  const containerMetrics = latestMetrics?.containers?.filter(
    (c) => c.tenantId === tenantId && c.appId === appId,
  ) || [];

  const tenantAction = useTenantAction(appId!);
  const restartContainer = useRestartContainer();

  const [selectedContainer, setSelectedContainer] = useState<string | null>(null);
  const [tail, setTail] = useState<number>(200);

  const { data: logs, isLoading: logsLoading } = useContainerLogs(selectedContainer, tail);

  // Auto-select first container
  useEffect(() => {
    if (!selectedContainer && tenant?.containers?.length) {
      setSelectedContainer(tenant.containers[0].id);
    }
  }, [tenant?.containers, selectedContainer]);

  const handleTenantAction = (action: 'start' | 'stop' | 'restart') => {
    tenantAction.mutate(
      { tenantId: tenantId!, action },
      { onError: (err) => toast.error(err.message) },
    );
  };

  const handleRestartContainer = (containerId: string) => {
    restartContainer.mutate(containerId, {
      onError: (err) => toast.error(err.message),
      onSuccess: () => toast.success('Container restarting'),
    });
  };

  const getContainerMetrics = (containerName: string): ContainerMetrics | undefined =>
    containerMetrics.find((m) => m.containerName === containerName);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-6xl">
        <div className="flex justify-center py-20"><span className="spinner" /></div>
      </div>
    );
  }

  if (!tenant) {
    return (
      <div className="mx-auto max-w-6xl">
        <div className="card py-16 text-center">
          <p className="text-content-muted">Tenant not found.</p>
          <Link to={`/apps/${appId}/tenants`} className="mt-4 inline-block text-sm text-accent-primary hover:underline">
            Back to Tenants
          </Link>
        </div>
      </div>
    );
  }

  const runningCount = tenant.containers.filter((c) => c.state === 'running').length;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <Link to={`/apps/${appId}/tenants`} className="mb-2 inline-flex items-center gap-1 text-sm text-content-muted hover:text-content-secondary">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
            Back to Tenants
          </Link>
          <h1 className="text-2xl font-bold text-content-primary">{tenant.tenantId}</h1>
          <div className="mt-1 flex flex-wrap gap-4 text-sm text-content-faint">
            <span>{tenant.domain}</span>
            <span>{tenant.version}</span>
            <span className={cn('inline-flex items-center gap-1.5')}>
              <span className={cn('h-2 w-2 rounded-full', tenant.healthy ? 'bg-green-400' : 'bg-red-400')} />
              {tenant.healthy ? 'Running' : 'Stopped'}
            </span>
            {tenantMetrics && (
              <>
                <span>CPU: {tenantMetrics.totalCpu.toFixed(1)}%</span>
                <span>Mem: {formatBytes(tenantMetrics.totalMem)}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          {tenant.healthy ? (
            <>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => handleTenantAction('restart')}
                disabled={tenantAction.isPending}
              >
                Restart
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => handleTenantAction('stop')}
                disabled={tenantAction.isPending}
              >
                Stop
              </button>
            </>
          ) : (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => handleTenantAction('start')}
              disabled={tenantAction.isPending}
            >
              Start
            </button>
          )}
        </div>
      </div>

      {/* Containers */}
      <section className="card">
        <h2 className="mb-4 text-lg font-semibold text-content-primary">
          Containers ({runningCount}/{tenant.containers.length} running)
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-content-faint">
                <th className="pb-2 pr-4 font-medium">Service</th>
                <th className="pb-2 pr-4 font-medium">State</th>
                <th className="pb-2 pr-4 font-medium">Image</th>
                <th className="pb-2 pr-4 font-medium">Uptime</th>
                <th className="pb-2 pr-4 font-medium text-right">CPU</th>
                <th className="pb-2 pr-4 font-medium text-right">Mem</th>
                <th className="pb-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {tenant.containers.map((container) => {
                const m = getContainerMetrics(container.name);
                const isSelected = container.id === selectedContainer;
                return (
                  <tr
                    key={container.id}
                    className={cn(
                      'cursor-pointer border-b border-border/50 transition-colors hover:bg-surface-subtle',
                      isSelected && 'bg-surface-subtle',
                    )}
                    onClick={() => setSelectedContainer(container.id)}
                  >
                    <td className="py-2 pr-4 font-medium text-content-primary">
                      {container.service || container.name}
                    </td>
                    <td className="py-2 pr-4">
                      <span className="inline-flex items-center gap-1.5">
                        <span className={cn('h-2 w-2 rounded-full', container.state === 'running' ? 'bg-green-400' : container.state === 'exited' ? 'bg-red-400' : 'bg-yellow-400')} />
                        <span className="text-content-secondary">{container.state}</span>
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-content-faint">{container.image}</td>
                    <td className="py-2 pr-4 text-content-faint">
                      {container.status || (container.created ? formatRelativeTime(container.created) : '—')}
                    </td>
                    <td className="py-2 pr-4 text-right text-content-secondary">
                      {m ? `${m.cpuPercent.toFixed(1)}%` : '—'}
                    </td>
                    <td className="py-2 pr-4 text-right text-content-secondary">
                      {m ? formatBytes(m.memUsage) : '—'}
                    </td>
                    <td className="py-2 text-right">
                      <button
                        className="btn btn-ghost btn-sm text-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRestartContainer(container.id);
                        }}
                        disabled={restartContainer.isPending}
                        title="Restart container"
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Log Viewer */}
      {selectedContainer && (
        <LogViewer
          containerName={tenant.containers.find((c) => c.id === selectedContainer)?.service || selectedContainer}
          logs={logs || null}
          isLoading={logsLoading}
          tail={tail}
          onTailChange={setTail}
        />
      )}
    </div>
  );
}

function LogViewer({
  containerName,
  logs,
  isLoading,
  tail,
  onTailChange,
}: {
  containerName: string;
  logs: string | null;
  isLoading: boolean;
  tail: number;
  onTailChange: (n: number) => void;
}) {
  const scrollRef = useRef<HTMLPreElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
  };

  return (
    <section className="card">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-content-primary">
          Logs: {containerName}
        </h2>
        <div className="flex items-center gap-2">
          <label className="text-xs text-content-faint">Tail:</label>
          <select
            className="input w-auto py-1 text-xs"
            value={tail}
            onChange={(e) => onTailChange(Number(e.target.value))}
          >
            {TAIL_OPTIONS.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
      </div>
      <pre
        ref={scrollRef}
        onScroll={handleScroll}
        className="max-h-96 overflow-auto rounded-lg bg-[#0d1117] p-4 font-mono text-xs leading-5 text-gray-300"
      >
        {isLoading ? (
          <span className="text-content-faint">Loading logs...</span>
        ) : logs ? (
          logs
        ) : (
          <span className="text-content-faint">No logs available</span>
        )}
      </pre>
    </section>
  );
}
