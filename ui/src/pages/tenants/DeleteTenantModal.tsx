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
        This will permanently delete the tenant and all its data. Type the tenant ID{' '}
        <code className="text-red-300">{tenantId}</code> below to confirm.
      </p>
      <input
        className="input mb-3"
        placeholder={`Type ${tenantId} to confirm`}
        value={confirmText}
        onChange={(e) => setConfirmText(e.target.value)}
      />
      <label className="mb-4 flex items-center gap-2 text-sm text-content-tertiary">
        <input type="checkbox" checked={keepData} onChange={(e) => setKeepData(e.target.checked)} />
        Keep database (only remove containers)
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
