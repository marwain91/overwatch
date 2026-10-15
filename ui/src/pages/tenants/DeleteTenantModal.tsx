import { useState } from 'react';
import { toast } from 'sonner';
import { useDeleteTenant } from '../../hooks/useTenants';
import { Modal } from '../../components/Modal';

export function DeleteTenantModal({ appId, tenantId, onClose }: { appId: string; tenantId: string; onClose: () => void }) {
  const deleteTenant = useDeleteTenant(appId);
  const [keepData, setKeepData] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  const canDelete = confirmText === tenantId && !deleteTenant.isPending;

  return (
    <Modal title={`Delete ${tenantId}`} onClose={onClose}>
      <p className="mb-4 text-sm text-content-muted">
        {keepData
          ? 'This removes the tenant from Overwatch and its containers, and keeps its data.'
          : 'This will permanently delete the tenant, its database and its own volumes.'}{' '}
        Type the tenant ID <code className="text-red-300">{tenantId}</code> below to confirm.
      </p>
      <input
        className="input mb-3"
        placeholder={`Type ${tenantId} to confirm`}
        value={confirmText}
        onChange={(e) => setConfirmText(e.target.value)}
      />
      <label className="mb-4 flex items-start gap-2 text-sm text-content-tertiary">
        <input type="checkbox" className="mt-0.5" checked={keepData} onChange={(e) => setKeepData(e.target.checked)} />
        <span>
          Keep data: keeps the database, the tenant's Docker volumes and a copy of its <code>.env</code> (with the
          database password) in <code>data/deleted-tenants/</code>. The containers, the tenant directory and its
          environment variable overrides are removed.
        </span>
      </label>
      <div className="flex justify-end gap-2">
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button
          className="btn btn-danger"
          disabled={!canDelete}
          onClick={() => deleteTenant.mutate({ tenantId, keepData }, {
            onSuccess: () => { toast.success(`Tenant ${tenantId} deleted`); onClose(); },
            onError: (err) => toast.error(err.message),
          })}
        >
          {deleteTenant.isPending ? 'Deleting...' : 'Delete'}
        </button>
      </div>
    </Modal>
  );
}
