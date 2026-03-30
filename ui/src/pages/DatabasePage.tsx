import { useState } from 'react';
import { toast } from 'sonner';
import { useDatabaseInfo, useDatabaseStats, useDatabaseList, useDatabaseProcesses, useKillProcess } from '../hooks/useDatabase';
import { formatBytes, formatUptime, formatNumber } from '../lib/format';
import { cn } from '../lib/cn';

const tabs = ['overview', 'databases', 'processes'] as const;
type Tab = typeof tabs[number];

export function DatabasePage() {
  const [activeTab, setActiveTab] = useState<Tab>('overview');

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <h1 className="text-2xl font-bold text-content-primary">Database</h1>

      <div className="flex gap-1 border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab}
            className={cn(
              'px-4 py-2 text-sm font-medium capitalize transition-colors',
              activeTab === tab
                ? 'border-b-2 border-brand-400 text-brand-400'
                : 'text-content-muted hover:text-content-secondary',
            )}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && <OverviewTab />}
      {activeTab === 'databases' && <DatabasesTab />}
      {activeTab === 'processes' && <ProcessesTab />}
    </div>
  );
}

function OverviewTab() {
  const { data: info, isLoading: infoLoading } = useDatabaseInfo();
  const { data: stats, isLoading: statsLoading } = useDatabaseStats();

  if (infoLoading || statsLoading) {
    return <div className="card"><span className="spinner" /> Loading...</div>;
  }

  return (
    <div className="space-y-6">
      {/* Server Info */}
      <div className="card">
        <h2 className="mb-4 text-lg font-semibold text-content-primary">Server Info</h2>
        {info ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <InfoItem label="Type" value={info.type.charAt(0).toUpperCase() + info.type.slice(1)} />
            <InfoItem label="Version" value={info.version} />
            <InfoItem label="Uptime" value={formatUptime(info.uptime)} />
            <InfoItem label="Host" value={`${info.host}:${info.port}`} />
          </div>
        ) : (
          <p className="text-sm text-content-muted">Unable to connect to database server.</p>
        )}
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Connections"
            value={stats.connections.active}
            detail={`/ ${stats.connections.max} max`}
            bar={stats.connections.max > 0 ? (stats.connections.active / stats.connections.max) * 100 : 0}
          />
          <StatCard
            label="Queries"
            value={formatNumber(stats.queries.total)}
            detail={`${stats.queries.perSecond}/s`}
          />
          <StatCard
            label="Threads"
            value={stats.threads.running}
            detail={`running / ${stats.threads.connected} connected`}
          />
          <StatCard
            label="Buffer Pool"
            value={formatBytes(stats.memory.bufferPoolUsed || stats.memory.bufferPoolSize)}
            detail={stats.memory.bufferPoolUsed > 0
              ? `/ ${formatBytes(stats.memory.bufferPoolSize)} allocated`
              : 'allocated'}
            bar={stats.memory.bufferPoolSize > 0 && stats.memory.bufferPoolUsed > 0
              ? (stats.memory.bufferPoolUsed / stats.memory.bufferPoolSize) * 100
              : undefined}
          />
        </div>
      )}
    </div>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-content-faint">{label}</p>
      <p className="text-sm font-medium text-content-secondary break-all">{value}</p>
    </div>
  );
}

function StatCard({ label, value, detail, bar }: { label: string; value: string | number; detail: string; bar?: number }) {
  return (
    <div className="card">
      <p className="text-xs text-content-faint">{label}</p>
      <p className="mt-1 text-2xl font-bold text-content-primary">{value}</p>
      <p className="text-xs text-content-muted">{detail}</p>
      {bar !== undefined && (
        <div className="mt-2 h-1.5 rounded-full bg-surface-subtle">
          <div
            className={cn('h-1.5 rounded-full transition-all', bar > 80 ? 'bg-red-500' : bar > 60 ? 'bg-yellow-500' : 'bg-brand-500')}
            style={{ width: `${Math.min(bar, 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

function DatabasesTab() {
  const { data: databases, isLoading } = useDatabaseList();
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'size'>('size');

  if (isLoading) {
    return <div className="card"><span className="spinner" /> Loading...</div>;
  }

  const filtered = (databases || [])
    .filter((db) => !search || db.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => sortBy === 'size' ? b.sizeBytes - a.sizeBytes : a.name.localeCompare(b.name));

  const totalSize = (databases || []).reduce((sum, db) => sum + db.sizeBytes, 0);
  const tenantCount = (databases || []).filter((db) => db.isTenantDb).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          className="input max-w-xs"
          placeholder="Search databases..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex items-center gap-2 text-sm text-content-muted">
          <span>{databases?.length || 0} databases</span>
          <span className="text-content-faint">|</span>
          <span>{tenantCount} tenant</span>
          <span className="text-content-faint">|</span>
          <span>{formatBytes(totalSize)} total</span>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-content-faint">
              <th className="pb-2 pr-4">
                <button className="hover:text-content-secondary" onClick={() => setSortBy('name')}>
                  Name {sortBy === 'name' && '↑'}
                </button>
              </th>
              <th className="pb-2 pr-4">
                <button className="hover:text-content-secondary" onClick={() => setSortBy('size')}>
                  Size {sortBy === 'size' && '↓'}
                </button>
              </th>
              <th className="pb-2 pr-4">Tables</th>
              <th className="pb-2">Type</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((db) => (
              <tr key={db.name} className="border-b border-border-subtle hover:bg-surface-muted">
                <td className="py-2 pr-4 font-mono text-content-secondary">{db.name}</td>
                <td className="py-2 pr-4 text-content-muted">{formatBytes(db.sizeBytes)}</td>
                <td className="py-2 pr-4 text-content-muted">{db.tableCount || '—'}</td>
                <td className="py-2">
                  {db.isTenantDb ? (
                    <span className="badge badge-blue">Tenant</span>
                  ) : (
                    <span className="badge badge-gray">System</span>
                  )}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={4} className="py-4 text-center text-content-muted">No databases found.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProcessesTab() {
  const { data: processes, isLoading } = useDatabaseProcesses();
  const killProcess = useKillProcess();
  const [confirmKill, setConfirmKill] = useState<number | null>(null);

  if (isLoading) {
    return <div className="card"><span className="spinner" /> Loading...</div>;
  }

  const handleKill = (id: number) => {
    killProcess.mutate(id, {
      onSuccess: () => {
        toast.success(`Process ${id} terminated`);
        setConfirmKill(null);
      },
      onError: (err) => toast.error(err.message),
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 text-sm text-content-muted">
        <span>{processes?.length || 0} processes</span>
        <span className="text-content-faint">|</span>
        <span className="text-xs text-content-faint">Auto-refreshes every 5s</span>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-content-faint">
              <th className="pb-2 pr-4">ID</th>
              <th className="pb-2 pr-4">User</th>
              <th className="pb-2 pr-4">Database</th>
              <th className="pb-2 pr-4">Command</th>
              <th className="pb-2 pr-4">Time</th>
              <th className="pb-2 pr-4">State</th>
              <th className="pb-2 pr-4">Query</th>
              <th className="pb-2"></th>
            </tr>
          </thead>
          <tbody>
            {(processes || []).map((p) => (
              <tr key={p.id} className="border-b border-border-subtle hover:bg-surface-muted">
                <td className="py-2 pr-4 font-mono text-content-muted">{p.id}</td>
                <td className="py-2 pr-4 text-content-secondary">{p.user}</td>
                <td className="py-2 pr-4 text-content-muted">{p.database || '—'}</td>
                <td className="py-2 pr-4">
                  <span className={cn('badge', p.command === 'Query' || p.command === 'active' ? 'badge-green' : 'badge-gray')}>
                    {p.command}
                  </span>
                </td>
                <td className="py-2 pr-4 text-content-muted">{p.time}s</td>
                <td className="py-2 pr-4 text-content-faint text-xs">{p.state}</td>
                <td className="py-2 pr-4 max-w-xs truncate font-mono text-xs text-content-faint" title={p.query || ''}>
                  {p.query || '—'}
                </td>
                <td className="py-2">
                  {confirmKill === p.id ? (
                    <div className="flex gap-1">
                      <button
                        className="btn btn-danger btn-xs"
                        onClick={() => handleKill(p.id)}
                        disabled={killProcess.isPending}
                      >
                        Confirm
                      </button>
                      <button className="btn btn-secondary btn-xs" onClick={() => setConfirmKill(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      className="btn btn-secondary btn-xs"
                      onClick={() => setConfirmKill(p.id)}
                    >
                      Kill
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {(!processes || processes.length === 0) && (
              <tr>
                <td colSpan={8} className="py-4 text-center text-content-muted">No active processes.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
