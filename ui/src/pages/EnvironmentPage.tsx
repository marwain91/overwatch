import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { Modal } from '../components/Modal';
import type { EnvVar } from '../lib/types';

export function EnvironmentPage() {
  const { appId } = useParams<{ appId: string }>();
  const qc = useQueryClient();

  const { data: vars, isLoading } = useQuery({
    queryKey: ['env-vars', appId],
    queryFn: () => api.get<EnvVar[]>(`/apps/${appId}/env-vars`),
    enabled: !!appId,
  });

  const saveVar = useMutation({
    mutationFn: (data: { key: string; value: string; sensitive: boolean; description?: string }) =>
      api.post<{ tenantsAffected: number }>(`/apps/${appId}/env-vars`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['env-vars', appId] });
    },
  });

  const deleteVar = useMutation({
    mutationFn: (key: string) => api.delete<{ tenantsAffected: number }>(`/apps/${appId}/env-vars/${encodeURIComponent(key)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['env-vars', appId] });
    },
  });

  const [showModal, setShowModal] = useState<{ key?: string; value?: string; sensitive?: boolean; description?: string } | null>(null);
  const [showDeleteKey, setShowDeleteKey] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-content-primary">Environment Variables</h1>
          <p className="mt-1 text-sm text-content-muted">
            Global variables inherited by all tenants. Per-tenant overrides available via tenant settings.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowModal({})}>
          + Add Variable
        </button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><span className="spinner" /></div>
      ) : vars && vars.length > 0 ? (
        <div className="space-y-2">
          {vars.map((v) => (
            <div key={v.key} className="card flex items-center justify-between">
              <div>
                <p className="font-mono text-sm text-content-secondary">{v.key}</p>
                <p className="mt-0.5 font-mono text-xs text-content-faint">
                  {v.sensitive ? '••••••••' : v.value}
                </p>
                {v.description && <p className="mt-0.5 text-xs text-content-fainter">{v.description}</p>}
              </div>
              <div className="flex gap-2">
                <button
                  className="btn btn-secondary btn-xs"
                  onClick={() => setShowModal({ key: v.key, value: v.sensitive ? '' : v.value, sensitive: v.sensitive, description: v.description })}
                >
                  Edit
                </button>
                <button className="btn btn-danger btn-xs" onClick={() => setShowDeleteKey(v.key)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="card text-center py-12">
          <p className="text-content-muted">No environment variables defined.</p>
        </div>
      )}

      {/* Add/Edit Modal */}
      {showModal && (
        <EnvVarModal
          initial={showModal}
          onClose={() => setShowModal(null)}
          onSave={(data) => {
            saveVar.mutate(data, {
              onSuccess: (result) => {
                toast.success(`Variable ${data.key} saved`);
                setShowModal(null);
                if (result.tenantsAffected > 0) {
                  toast.info(`${result.tenantsAffected} tenant(s) affected. Restart to apply.`);
                }
              },
              onError: (err) => toast.error(err.message),
            });
          }}
          saving={saveVar.isPending}
        />
      )}

      {/* Delete Confirmation */}
      {showDeleteKey && (
        <Modal title="Delete Variable" size="sm" onClose={() => setShowDeleteKey(null)}>
          <p className="mb-4 text-sm text-content-muted">
            Delete <strong className="text-content-secondary">{showDeleteKey}</strong>? This will remove it from all tenant shared.env files.
          </p>
          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={() => setShowDeleteKey(null)}>Cancel</button>
            <button
              className="btn btn-danger"
              disabled={deleteVar.isPending}
              onClick={() => deleteVar.mutate(showDeleteKey, {
                onSuccess: (result) => {
                  toast.success(`Variable ${showDeleteKey} deleted`);
                  setShowDeleteKey(null);
                  if (result.tenantsAffected > 0) {
                    toast.info(`${result.tenantsAffected} tenant(s) affected. Restart to apply.`);
                  }
                },
                onError: (err) => toast.error(err.message),
              })}
            >
              {deleteVar.isPending ? 'Deleting...' : 'Delete'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function EnvVarModal({
  initial,
  onClose,
  onSave,
  saving,
}: {
  initial: { key?: string; value?: string; sensitive?: boolean; description?: string };
  onClose: () => void;
  onSave: (data: { key: string; value: string; sensitive: boolean; description?: string }) => void;
  saving: boolean;
}) {
  const isEdit = !!initial.key;
  const [key, setKey] = useState(initial.key || '');
  const [value, setValue] = useState(initial.value || '');
  const [sensitive, setSensitive] = useState(initial.sensitive || false);
  const [description, setDescription] = useState(initial.description || '');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({ key, value, sensitive, description: description || undefined });
  };

  return (
    <Modal title={`${isEdit ? 'Edit' : 'Add'} Variable`} size="md" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="label">Key</label>
          <input
            className="input"
            value={key}
            onChange={(e) => setKey(e.target.value.toUpperCase())}
            pattern="[A-Z][A-Z0-9_]*"
            disabled={isEdit}
            required
          />
        </div>
        <div>
          <label className="label">Value</label>
          <input className="input" value={value} onChange={(e) => setValue(e.target.value)} placeholder={sensitive && isEdit ? 'Leave blank to keep current' : ''} required={!sensitive || !isEdit} />
        </div>
        <label className="flex items-center gap-2 text-sm text-content-tertiary">
          <input type="checkbox" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} />
          Sensitive (mask in UI)
        </label>
        <div>
          <label className="label">Description (optional)</label>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
