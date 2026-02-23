import { useState } from 'react';
import { toast } from 'sonner';
import { useUpdateTenant } from '../../hooks/useTenants';
import { Modal } from '../../components/Modal';
import { TagInput } from '../../components/TagInput';

export function UpdateTenantModal({ appId, tenantId, currentVersion, onClose }: { appId: string; tenantId: string; currentVersion: string; onClose: () => void }) {
  const update = useUpdateTenant(appId);
  const [imageTag, setImageTag] = useState(currentVersion);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    update.mutate({ tenantId, imageTag }, {
      onSuccess: () => { toast.success(`Tenant ${tenantId} updated`); onClose(); },
      onError: (err) => toast.error(err.message),
    });
  };

  return (
    <Modal title={`Update ${tenantId}`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="label">New Image Tag</label>
          <TagInput appId={appId} value={imageTag} onChange={setImageTag} />
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={update.isPending}>
            {update.isPending ? 'Updating...' : 'Update'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
