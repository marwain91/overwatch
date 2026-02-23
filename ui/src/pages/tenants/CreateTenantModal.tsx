import { useState } from 'react';
import { toast } from 'sonner';
import { useCreateTenant } from '../../hooks/useTenants';
import { Modal } from '../../components/Modal';
import { TagInput } from '../../components/TagInput';

export function CreateTenantModal({ appId, onClose }: { appId: string; onClose: () => void }) {
  const create = useCreateTenant(appId);
  const [tenantId, setTenantId] = useState('');
  const [domain, setDomain] = useState('');
  const [imageTag, setImageTag] = useState('latest');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    create.mutate(
      { tenantId, domain, imageTag },
      {
        onSuccess: () => { toast.success(`Tenant ${tenantId} created`); onClose(); },
        onError: (err) => toast.error(err.message),
      },
    );
  };

  return (
    <Modal title="Create Tenant" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="label">Tenant ID</label>
          <input className="input" value={tenantId} onChange={(e) => setTenantId(e.target.value)} placeholder="acme" required pattern="[a-z0-9]+(-[a-z0-9]+)*" />
        </div>
        <div>
          <label className="label">Domain</label>
          <input className="input" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="acme.example.com" required />
        </div>
        <div>
          <label className="label">Image Tag</label>
          <TagInput appId={appId} value={imageTag} onChange={setImageTag} />
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={create.isPending}>
            {create.isPending ? 'Creating...' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
