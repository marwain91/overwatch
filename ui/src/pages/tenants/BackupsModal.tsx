import { useState } from 'react';
import { toast } from 'sonner';
import { useBackupStatus, useTenantBackups, useCreateBackup, useRestoreBackup, useDeleteBackup } from '../../hooks/useTenants';
import { Modal } from '../../components/Modal';
import type { Tenant } from '../../lib/types';

export function BackupsModal({ appId, tenantId, tenants, onClose }: { appId: string; tenantId: string; tenants: Tenant[]; onClose: () => void }) {
  const { data: status } = useBackupStatus(appId);
  const { data: backups, isLoading } = useTenantBackups(appId, tenantId);
  const createBackup = useCreateBackup(appId);
  const restoreBackup = useRestoreBackup(appId);
  const deleteBackup = useDeleteBackup(appId);

  const [restoreTarget, setRestoreTarget] = useState<{ snapshotId: string; tenantId: string } | null>(null);

  if (!status?.configured) {
    return <Modal title={`Backups: ${tenantId}`} onClose={onClose}><p className="text-content-muted">Backups not configured.</p></Modal>;
  }

  return (
    <Modal title={`Backups: ${tenantId}`} onClose={onClose}>
      <div className="mb-4 flex justify-end">
        <button
          className="btn btn-primary btn-sm"
          disabled={createBackup.isPending}
          onClick={() => createBackup.mutate(tenantId, {
            onSuccess: () => toast.success('Backup created'),
            onError: (err) => toast.error(err.message),
          })}
        >
          {createBackup.isPending ? 'Backing up...' : '+ Create Backup'}
        </button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8"><span className="spinner" /></div>
      ) : backups && backups.length > 0 ? (
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {backups.map((b) => (
            <div key={b.id} className="flex items-center justify-between rounded border border-border-subtle bg-surface-muted px-3 py-2">
              <div>
                <p className="text-sm text-content-secondary">{new Date(b.time).toLocaleString()}</p>
                <p className="text-xs text-content-faint">{b.shortId}</p>
              </div>
              <div className="flex gap-1">
                <button className="btn btn-secondary btn-xs" onClick={() => setRestoreTarget({ snapshotId: b.id, tenantId })}>Restore</button>
                <button
                  className="btn btn-danger btn-xs"
                  onClick={() => deleteBackup.mutate(b.id, {
                    onSuccess: () => toast.success('Backup deleted'),
                    onError: (err) => toast.error(err.message),
                  })}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-content-muted">No backups yet.</p>
      )}

      {restoreTarget && (
        <div className="mt-4 border-t border-border-subtle pt-4">
          <h3 className="mb-2 text-sm font-medium text-content-secondary">Restore to:</h3>
          <select className="input mb-2" value={restoreTarget.tenantId} onChange={(e) => setRestoreTarget({ ...restoreTarget, tenantId: e.target.value })}>
            {tenants.map((t) => <option key={t.tenantId} value={t.tenantId}>{t.tenantId}</option>)}
          </select>
          <div className="flex gap-2">
            <button className="btn btn-danger btn-sm" onClick={() => restoreBackup.mutate(restoreTarget, {
              onSuccess: () => { toast.success('Backup restored'); setRestoreTarget(null); },
              onError: (err) => toast.error(err.message),
            })} disabled={restoreBackup.isPending}>
              {restoreBackup.isPending ? 'Restoring...' : 'Restore'}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => setRestoreTarget(null)}>Cancel</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
