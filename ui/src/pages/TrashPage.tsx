import { useState } from 'react';
import { toast } from 'sonner';
import { Modal } from '../components/Modal';
import { useTrashedApps, useRestoreApp, usePurgeApp } from '../hooks/useApps';
import { useAdminUsers } from '../hooks/useAdminUsers';
import { useAuthStore } from '../stores/authStore';
import { formatRelativeTime } from '../lib/format';

export function TrashPage() {
  const { data: trashed, isLoading, error } = useTrashedApps();
  const restore = useRestoreApp();
  const purge = usePurgeApp();
  const email = useAuthStore((s) => s.user?.email);
  const { data: admins } = useAdminUsers();
  // Restore and purge are admin-only on the API; hide them for everyone else
  // (and until the role is known) instead of offering buttons that return 403.
  const isAdmin = admins?.find((a) => a.email === email)?.role === 'admin';

  const [purgeId, setPurgeId] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');

  const closePurge = () => {
    setPurgeId(null);
    setConfirmText('');
  };

  const handleRestore = (appId: string) => {
    restore.mutate(appId, {
      onSuccess: () => toast.success(`App ${appId} restored`),
      onError: (err) => toast.error(err.message),
    });
  };

  const handlePurge = () => {
    if (!purgeId) return;
    purge.mutate(purgeId, {
      onSuccess: () => {
        toast.success(`App ${purgeId} permanently removed`);
        closePurge();
      },
      onError: (err) => toast.error(err.message),
    });
  };

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-content-primary">Deleted apps</h1>
        <p className="mt-1 text-sm text-content-muted">
          Soft-deleted app definitions. Restore one to bring it back, or purge it to remove it for good.
        </p>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20">
          <span className="spinner" />
        </div>
      ) : error ? (
        <div className="card text-center py-12 text-red-400">
          Failed to load deleted apps: {error.message}
        </div>
      ) : trashed && trashed.length > 0 ? (
        <div className="space-y-3">
          {trashed.map(({ app, deletedAt, deletedBy, tenantCount }) => (
            <div key={app.id} className="card flex items-center justify-between gap-4">
              <div>
                <h3 className="font-semibold text-content-primary">{app.name}</h3>
                <p className="text-xs text-content-faint">{app.id}</p>
                <p className="mt-1 text-xs text-content-muted">
                  Deleted {formatRelativeTime(deletedAt)} by {deletedBy}
                  {tenantCount > 0 && ` - ${tenantCount} tenant${tenantCount === 1 ? '' : 's'} still exist`}
                </p>
              </div>
              {isAdmin && (
                <div className="flex shrink-0 gap-2">
                  <button
                    className="btn btn-primary"
                    disabled={restore.isPending}
                    onClick={() => handleRestore(app.id)}
                  >
                    Restore
                  </button>
                  <button className="btn btn-danger" onClick={() => setPurgeId(app.id)}>
                    Purge
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="card text-center py-16 text-content-muted">No deleted apps.</div>
      )}

      {purgeId && (
        <Modal title="Purge app permanently" size="md" onClose={closePurge}>
          <p className="mb-3 text-sm text-content-muted">
            This permanently removes the definition of <strong>{purgeId}</strong> from the trash. It cannot be undone.
            Type the app id to confirm.
          </p>
          <input
            className="input mb-4"
            placeholder={`Type ${purgeId} to confirm`}
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={closePurge}>Cancel</button>
            <button
              className="btn btn-danger"
              disabled={purge.isPending || confirmText !== purgeId}
              onClick={handlePurge}
            >
              {purge.isPending ? 'Purging...' : 'Purge'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
