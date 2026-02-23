import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useApp, useUpdateApp, useDeleteApp, useBackupSummary } from '../hooks/useApps';
import { formatRelativeTime } from '../lib/format';
import type { AppService, AppRegistry, AppBackup, AppAdminAccess } from '../lib/types';

export function AppSettingsPage() {
  const { appId } = useParams<{ appId: string }>();
  const navigate = useNavigate();
  const { data: app, isLoading } = useApp(appId!);
  const { data: backupSummary } = useBackupSummary(appId!);
  const updateApp = useUpdateApp(appId!);
  const deleteApp = useDeleteApp();

  const [name, setName] = useState('');
  const [domainTemplate, setDomainTemplate] = useState('');
  const [defaultImageTag, setDefaultImageTag] = useState('latest');
  const [registry, setRegistry] = useState<AppRegistry | null>(null);
  const [services, setServices] = useState<AppService[]>([]);
  const [backup, setBackup] = useState<AppBackup | null>(null);
  const [adminAccess, setAdminAccess] = useState<AppAdminAccess | null>(null);
  const [showDelete, setShowDelete] = useState(false);

  useEffect(() => {
    if (app) {
      setName(app.name);
      setDomainTemplate(app.domain_template);
      setDefaultImageTag(app.default_image_tag);
      setRegistry(app.registry);
      setServices(app.services);
      setBackup(app.backup || { enabled: false, provider: 's3' });
      setAdminAccess(app.admin_access || { enabled: false });
    }
  }, [app]);

  const handleSave = async () => {
    try {
      await updateApp.mutateAsync({
        name,
        domain_template: domainTemplate,
        default_image_tag: defaultImageTag,
        registry: registry!,
        services,
        backup: backup?.enabled ? backup : undefined,
        admin_access: adminAccess?.enabled ? adminAccess : undefined,
      });
      toast.success('App settings saved');
    } catch (err: unknown) {
      toast.error((err as Error).message);
    }
  };

  const handleDelete = async () => {
    try {
      await deleteApp.mutateAsync({ appId: appId!, force: true });
      toast.success('App deleted');
      navigate('/');
    } catch (err: unknown) {
      toast.error((err as Error).message);
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <span className="spinner" />
      </div>
    );
  }

  if (!app) {
    return <p className="text-content-muted">App not found.</p>;
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-content-primary">Settings — {app.name}</h1>
        <button className="btn btn-primary" onClick={handleSave} disabled={updateApp.isPending}>
          {updateApp.isPending ? <><span className="spinner spinner-sm" /> Saving...</> : 'Save Changes'}
        </button>
      </div>

      {/* Basic Info */}
      <div className="card mb-4">
        <h2 className="mb-4 text-lg font-semibold text-content-secondary">Basic Info</h2>
        <div className="space-y-3">
          <div>
            <label className="label">App ID</label>
            <input className="input bg-surface-raised" value={appId} disabled />
          </div>
          <div>
            <label className="label">Display Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="label">Domain Template</label>
            <input className="input" value={domainTemplate} onChange={(e) => setDomainTemplate(e.target.value)} />
          </div>
          <div>
            <label className="label">Default Image Tag</label>
            <input className="input" value={defaultImageTag} onChange={(e) => setDefaultImageTag(e.target.value)} />
          </div>
        </div>
      </div>

      {/* Registry */}
      {registry && (
        <div className="card mb-4">
          <h2 className="mb-4 text-lg font-semibold text-content-secondary">Registry</h2>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Type</label>
                <select className="input" value={registry.type} onChange={(e) => setRegistry({ ...registry, type: e.target.value as AppRegistry['type'] })}>
                  <option value="ghcr">GHCR</option>
                  <option value="dockerhub">Docker Hub</option>
                  <option value="ecr">AWS ECR</option>
                  <option value="custom">Custom</option>
                </select>
              </div>
              <div>
                <label className="label">URL</label>
                <input className="input" value={registry.url} onChange={(e) => setRegistry({ ...registry, url: e.target.value })} />
              </div>
            </div>
            <div>
              <label className="label">Repository</label>
              <input className="input" value={registry.repository} onChange={(e) => setRegistry({ ...registry, repository: e.target.value })} />
            </div>
          </div>
        </div>
      )}

      {/* Services */}
      <div className="card mb-4">
        <h2 className="mb-4 text-lg font-semibold text-content-secondary">Services ({services.length})</h2>
        <div className="space-y-3">
          {services.map((svc, i) => (
            <div key={i} className="rounded border border-border-subtle bg-surface-muted p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium text-content-secondary">{svc.name || 'Unnamed'}</span>
                <button className="text-xs text-red-400" onClick={() => setServices(services.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </div>
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="label">Name</label>
                    <input className="input" value={svc.name} onChange={(e) => { const n = [...services]; n[i] = { ...svc, name: e.target.value }; setServices(n); }} placeholder="backend" />
                  </div>
                  <div>
                    <label className="label">Internal Port</label>
                    <input className="input" type="number" value={svc.ports?.internal || ''} onChange={(e) => { const n = [...services]; n[i] = { ...svc, ports: { internal: parseInt(e.target.value) || 0 } }; setServices(n); }} placeholder="3000" />
                  </div>
                </div>
                {svc.image_suffix && (
                  <div>
                    <label className="label">Image Name Override</label>
                    <input className="input" value={svc.image_suffix} onChange={(e) => { const n = [...services]; n[i] = { ...svc, image_suffix: e.target.value || undefined }; setServices(n); }} placeholder={svc.name || 'defaults to service name'} />
                  </div>
                )}
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 text-xs text-content-tertiary">
                    <input type="checkbox" checked={svc.required} onChange={(e) => { const n = [...services]; n[i] = { ...svc, required: e.target.checked }; setServices(n); }} />
                    Required
                  </label>
                  <label className="flex items-center gap-2 text-xs text-content-tertiary">
                    <input type="checkbox" checked={svc.is_init_container} onChange={(e) => { const n = [...services]; n[i] = { ...svc, is_init_container: e.target.checked }; setServices(n); }} />
                    Init Container
                  </label>
                </div>
              </div>
            </div>
          ))}
          <button className="btn btn-secondary btn-sm" onClick={() => setServices([...services, { name: '', required: false, is_init_container: false }])}>
            + Add Service
          </button>
        </div>
      </div>

      {/* Backup Status */}
      {app.backup?.enabled && backupSummary && (
        <div className="card mb-4">
          <h2 className="mb-4 text-lg font-semibold text-content-secondary">Backups</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <p className="text-xs text-content-faint">Status</p>
              <p className={`mt-1 text-sm font-medium ${backupSummary.initialized ? 'text-green-400' : backupSummary.configured ? 'text-yellow-400' : 'text-red-400'}`}>
                {backupSummary.initialized ? 'Active' : backupSummary.configured ? 'Not initialized' : 'Not configured'}
              </p>
            </div>
            <div>
              <p className="text-xs text-content-faint">Schedule</p>
              <p className="mt-1 text-sm font-medium text-content-secondary">
                {backupSummary.schedule || 'Manual only'}
              </p>
            </div>
            <div>
              <p className="text-xs text-content-faint">Last Backup</p>
              <p className="mt-1 text-sm font-medium text-content-secondary">
                {backupSummary.lastBackup ? formatRelativeTime(backupSummary.lastBackup) : 'Never'}
              </p>
            </div>
            <div>
              <p className="text-xs text-content-faint">Total Snapshots</p>
              <p className="mt-1 text-sm font-medium text-content-secondary">
                {backupSummary.totalSnapshots}
              </p>
            </div>
          </div>
          {backupSummary.isLocked && (
            <p className="mt-3 text-xs text-yellow-400">Repository is currently locked by another operation.</p>
          )}
        </div>
      )}

      {/* Danger Zone */}
      <div className="card border-red-900/50">
        <h2 className="mb-4 text-lg font-semibold text-red-400">Danger Zone</h2>
        {!showDelete ? (
          <button className="btn btn-danger" onClick={() => setShowDelete(true)}>
            Delete App
          </button>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-content-muted">
              This will permanently delete the app and all its configuration. Tenants must be removed first, or use force delete.
            </p>
            <div className="flex gap-2">
              <button className="btn btn-danger" onClick={handleDelete} disabled={deleteApp.isPending}>
                {deleteApp.isPending ? 'Deleting...' : 'Confirm Delete'}
              </button>
              <button className="btn btn-secondary" onClick={() => setShowDelete(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
