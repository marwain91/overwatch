import { useState, useRef, useEffect } from 'react';
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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen]);

  const handleAction = (a: 'start' | 'stop' | 'restart') => {
    setMenuOpen(false);
    action.mutate(
      { tenantId: tenant.tenantId, action: a },
      { onError: (err) => toast.error(err.message) },
    );
  };

  const handleAccess = () => {
    setMenuOpen(false);
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
          <span>{tenant.version}</span>
          <span>{tenant.runningContainers}/{tenant.totalContainers} containers</span>
          {metrics && (
            <>
              <span>CPU: {metrics.totalCpu.toFixed(1)}%</span>
              <span>Mem: {formatBytes(metrics.totalMem)}</span>
            </>
          )}
        </div>
      </div>

      {/* Context menu */}
      <div className="relative" ref={menuRef}>
        <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setMenuOpen(!menuOpen)}>
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></svg>
        </button>
        {menuOpen && (
          <div className="absolute right-0 z-50 mt-1 w-44 rounded-lg border border-border bg-surface-raised py-1 shadow-lg">
            {tenant.healthy ? (
              <>
                <MenuItem onClick={handleAccess}>Open App</MenuItem>
                <MenuItem onClick={() => handleAction('restart')}>Restart</MenuItem>
                <MenuItem onClick={() => handleAction('stop')}>Stop</MenuItem>
              </>
            ) : (
              <MenuItem onClick={() => handleAction('start')}>Start</MenuItem>
            )}
            <div className="my-1 border-t border-border" />
            <MenuItem onClick={() => { setMenuOpen(false); onUpdate(); }}>Update Version</MenuItem>
            <MenuItem onClick={() => { setMenuOpen(false); onEnvVars(); }}>Environment</MenuItem>
            <MenuItem onClick={() => { setMenuOpen(false); onBackups(); }}>Backups</MenuItem>
            <div className="my-1 border-t border-border" />
            <MenuItem onClick={() => { setMenuOpen(false); onDelete(); }} className="text-red-400 hover:text-red-300">Delete</MenuItem>
          </div>
        )}
      </div>
    </div>
  );
}

function MenuItem({ children, onClick, className }: { children: React.ReactNode; onClick: () => void; className?: string }) {
  return (
    <button
      className={cn('w-full px-3 py-1.5 text-left text-sm text-content-secondary hover:bg-surface-subtle', className)}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
