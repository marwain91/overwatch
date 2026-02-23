import { Link } from 'react-router-dom';
import { useApps, useBackupSummaries } from '../hooks/useApps';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { formatRelativeTime } from '../lib/format';
import type { SystemHealth } from '../lib/types';

export function AppListPage() {
  const { data: apps, isLoading } = useApps();
  const { data: backupSummaries } = useBackupSummaries();
  const { data: health } = useQuery({
    queryKey: ['system-health'],
    queryFn: () => api.get<SystemHealth>('/status/health'),
    refetchInterval: 30_000,
  });

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-content-primary">Apps</h1>
          <p className="mt-1 text-sm text-content-muted">
            Manage your multi-tenant applications
          </p>
        </div>
        <Link to="/apps/new" className="btn btn-primary">
          + New App
        </Link>
      </div>

      {/* System Status */}
      {health && (
        <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatusCard label="Database" value={health.database} ok={health.database === 'connected'} />
          <StatusCard label="Containers" value={`${health.runningContainers}/${health.containers}`} ok={health.runningContainers === health.containers} />
          <StatusCard label="Apps" value={String(health.apps ?? apps?.length ?? 0)} ok />
          <StatusCard label="Backups" value={apps?.some(a => a.backup?.enabled) ? 'Enabled' : 'Disabled'} ok={!!apps?.some(a => a.backup?.enabled)} />
        </div>
      )}

      {/* App Grid */}
      {isLoading ? (
        <div className="flex justify-center py-20">
          <span className="spinner" />
        </div>
      ) : apps && apps.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {apps.map((app) => (
            <Link
              key={app.id}
              to={`/apps/${app.id}/tenants`}
              className="card group transition-colors hover:border-border-subtle"
            >
              <div className="mb-3 flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-600/20 text-lg font-bold text-brand-400">
                  {app.name.charAt(0).toUpperCase()}
                </span>
                <div>
                  <h3 className="font-semibold text-content-primary group-hover:text-brand-400">
                    {app.name}
                  </h3>
                  <p className="text-xs text-content-faint">{app.id}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 text-xs text-content-muted">
                <span className="badge badge-gray">{app.services.length} services</span>
                <span className="badge badge-gray">{app.registry.type}</span>
                <span className="badge badge-gray">{app.domain_template}</span>
                {app.backup?.enabled && <span className="badge badge-green">Backups</span>}
              </div>
              {backupSummaries?.[app.id]?.lastBackup && (
                <p className="mt-2 text-xs text-content-faint">
                  Last backup: {formatRelativeTime(backupSummaries[app.id].lastBackup!)} ({backupSummaries[app.id].totalSnapshots} snapshots)
                </p>
              )}
            </Link>
          ))}
        </div>
      ) : (
        <div className="card text-center py-16">
          <p className="mb-4 text-content-muted">No apps configured yet.</p>
          <Link to="/apps/new" className="btn btn-primary">
            Create your first app
          </Link>
        </div>
      )}
    </div>
  );
}

function StatusCard({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="card">
      <p className="text-xs text-content-faint">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${ok ? 'text-green-400' : 'text-red-400'}`}>
        {value}
      </p>
    </div>
  );
}
