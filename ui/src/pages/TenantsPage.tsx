import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { useApp } from '../hooks/useApps';
import { useTenants, useTenantAction, useAccessToken } from '../hooks/useTenants';
import { useWSStore } from '../stores/wsStore';
import { formatBytes } from '../lib/format';
import { cn } from '../lib/cn';
import type { Tenant } from '../lib/types';
import { CreateTenantModal } from './tenants/CreateTenantModal';
import { UpdateTenantModal } from './tenants/UpdateTenantModal';
import { DeleteTenantModal } from './tenants/DeleteTenantModal';
import { BackupsModal } from './tenants/BackupsModal';
import { TenantEnvVarsModal } from './tenants/TenantEnvVarsModal';

export function TenantsPage() {
  const { appId } = useParams<{ appId: string }>();
  const { data: app } = useApp(appId!);
  const { data: tenants, isLoading } = useTenants(appId!);
  const latestMetrics = useWSStore((s) => s.latestMetrics);

  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'name' | 'status' | 'version'>('name');

  // Modal states
  const [showCreate, setShowCreate] = useState(false);
  const [showUpdate, setShowUpdate] = useState<string | null>(null);
  const [showDelete, setShowDelete] = useState<string | null>(null);
  const [showBackups, setShowBackups] = useState<string | null>(null);
  const [showEnvVars, setShowEnvVars] = useState<string | null>(null);

  // Filter and sort
  const filtered = (tenants || [])
    .filter((t) => !search || t.tenantId.includes(search) || t.domain.includes(search))
    .sort((a, b) => {
      if (sort === 'status') return (b.healthy ? 1 : 0) - (a.healthy ? 1 : 0);
      if (sort === 'version') return (a.version || '').localeCompare(b.version || '', undefined, { numeric: true });
      return a.tenantId.localeCompare(b.tenantId);
    });

  // Get inline metrics for a tenant
  const getMetrics = (tenantId: string) =>
    latestMetrics?.tenants?.find((t) => t.tenantId === tenantId && t.appId === appId);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-content-primary">{app?.name || appId} — Tenants</h1>
          <p className="mt-1 text-sm text-content-muted">{filtered.length} tenants</p>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
            + Create Tenant
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="mb-4 flex gap-3">
        <input
          className="input max-w-xs"
          placeholder="Search by ID or domain..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="input w-auto" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="name">Sort: Name</option>
          <option value="status">Sort: Status</option>
          <option value="version">Sort: Version</option>
        </select>
      </div>

      {/* Tenant list */}
      {isLoading ? (
        <div className="flex justify-center py-20"><span className="spinner" /></div>
      ) : filtered.length === 0 ? (
        <div className="card py-16 text-center">
          <p className="text-content-muted">No tenants yet. Create your first tenant!</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((tenant) => (
            <TenantCard
              key={tenant.tenantId}
              tenant={tenant}
              appId={appId!}
              metrics={getMetrics(tenant.tenantId)}
              onUpdate={() => setShowUpdate(tenant.tenantId)}
              onDelete={() => setShowDelete(tenant.tenantId)}
              onBackups={() => setShowBackups(tenant.tenantId)}
              onEnvVars={() => setShowEnvVars(tenant.tenantId)}
            />
          ))}
        </div>
      )}

      {/* Modals */}
      {showCreate && (
        <CreateTenantModal appId={appId!} onClose={() => setShowCreate(false)} />
      )}
      {showUpdate && (
        <UpdateTenantModal appId={appId!} tenantId={showUpdate} currentVersion={tenants?.find(t => t.tenantId === showUpdate)?.version || 'latest'} onClose={() => setShowUpdate(null)} />
      )}
      {showDelete && (
        <DeleteTenantModal appId={appId!} tenantId={showDelete} onClose={() => setShowDelete(null)} />
      )}
      {showBackups && (
        <BackupsModal appId={appId!} tenantId={showBackups} tenants={tenants || []} onClose={() => setShowBackups(null)} />
      )}
      {showEnvVars && (
        <TenantEnvVarsModal appId={appId!} tenantId={showEnvVars} onClose={() => setShowEnvVars(null)} />
      )}
    </div>
  );
}

function TenantCard({
  tenant,
  appId,
  metrics,
  onUpdate,
  onDelete,
  onBackups,
  onEnvVars,
}: {
  tenant: Tenant;
  appId: string;
  metrics?: { totalCpu: number; totalMem: number; totalMemLimit: number };
  onUpdate: () => void;
  onDelete: () => void;
  onBackups: () => void;
  onEnvVars: () => void;
}) {
  const action = useTenantAction(appId);
  const accessToken = useAccessToken(appId);

  const handleAction = (a: 'start' | 'stop' | 'restart') => {
    action.mutate(
      { tenantId: tenant.tenantId, action: a },
      { onError: (err) => toast.error(err.message) },
    );
  };

  const handleAccess = () => {
    accessToken.mutate(tenant.tenantId, {
      onSuccess: (data) => window.open(data.accessUrl, '_blank'),
      onError: (err) => toast.error(err.message),
    });
  };

  return (
    <div className="card flex items-center gap-4">
      {/* Status + Info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-3">
          <span className={cn('h-2.5 w-2.5 rounded-full', tenant.healthy ? 'bg-green-400' : 'bg-red-400')} />
          <h3 className="text-sm font-semibold text-content-primary">{tenant.tenantId}</h3>
          <span className={cn('badge', tenant.healthy ? 'badge-green' : 'badge-red')}>
            {tenant.healthy ? 'Running' : 'Stopped'}
          </span>
        </div>
        <div className="mt-1 flex gap-4 text-xs text-content-faint">
          <span>{tenant.domain}</span>
          <span>v{tenant.version}</span>
          <span>{tenant.runningContainers}/{tenant.totalContainers} containers</span>
          {metrics && (
            <>
              <span>CPU: {metrics.totalCpu.toFixed(1)}%</span>
              <span>Mem: {formatBytes(metrics.totalMem)}</span>
            </>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-1.5">
        {tenant.healthy ? (
          <>
            <button className="btn btn-ghost btn-icon btn-sm" onClick={handleAccess} title="Access">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
            </button>
            <button className="btn btn-ghost btn-icon btn-sm" onClick={() => handleAction('restart')} title="Restart">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" /></svg>
            </button>
            <button className="btn btn-ghost btn-icon btn-sm" onClick={() => handleAction('stop')} title="Stop">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><rect x="6" y="6" width="12" height="12" /></svg>
            </button>
          </>
        ) : (
          <button className="btn btn-ghost btn-icon btn-sm" onClick={() => handleAction('start')} title="Start">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><polygon points="5 3 19 12 5 21 5 3" /></svg>
          </button>
        )}
        <button className="btn btn-ghost btn-icon btn-sm" onClick={onBackups} title="Backups">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" /><polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" /></svg>
        </button>
        <button className="btn btn-ghost btn-icon btn-sm" onClick={onEnvVars} title="Env Vars">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="4" /><path d="M12 3v1m0 16v1m-8-9H3m18 0h-1m-2.636-6.364l-.707.707M6.343 17.657l-.707.707m12.728 0l-.707-.707M6.343 6.343l-.707-.707" /></svg>
        </button>
        <button className="btn btn-ghost btn-icon btn-sm" onClick={onUpdate} title="Update">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
        </button>
        <button className="btn btn-ghost btn-icon btn-sm text-red-400 hover:text-red-300" onClick={onDelete} title="Delete">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
        </button>
      </div>
    </div>
  );
}
