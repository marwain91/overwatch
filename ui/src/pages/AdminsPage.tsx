import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { Modal } from '../components/Modal';
import type { AdminUser } from '../lib/types';

export function AdminsPage() {
  const qc = useQueryClient();
  const { data: admins, isLoading } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api.get<AdminUser[]>('/admin-users'),
  });

  const addAdmin = useMutation({
    mutationFn: (email: string) => api.post('/admin-users', { email }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users'] });
    },
  });

  const deleteAdmin = useMutation({
    mutationFn: (email: string) => api.delete(`/admin-users/${encodeURIComponent(email)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users'] });
    },
  });

  const [showAdd, setShowAdd] = useState(false);
  const [showDelete, setShowDelete] = useState<string | null>(null);
  const [email, setEmail] = useState('');

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    addAdmin.mutate(email, {
      onSuccess: () => {
        toast.success(`Admin ${email} added`);
        setShowAdd(false);
        setEmail('');
      },
      onError: (err) => toast.error(err.message),
    });
  };

  const handleDelete = () => {
    if (!showDelete) return;
    deleteAdmin.mutate(showDelete, {
      onSuccess: () => {
        toast.success(`Admin ${showDelete} removed`);
        setShowDelete(null);
      },
      onError: (err) => toast.error(err.message),
    });
  };

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-content-primary">Admin Users</h1>
          <p className="mt-1 text-sm text-content-muted">Manage who can access this admin panel.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
          + Add Admin
        </button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><span className="spinner" /></div>
      ) : admins && admins.length > 0 ? (
        <div className="space-y-2">
          {admins.map((admin) => (
            <div key={admin.email} className="card flex items-center justify-between">
              <div>
                <p className="text-sm text-content-secondary">{admin.email}</p>
                <p className="text-xs text-content-faint">
                  Added {new Date(admin.addedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} by {admin.addedBy}
                </p>
              </div>
              <button className="btn btn-danger btn-xs" onClick={() => setShowDelete(admin.email)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="card text-center py-12">
          <p className="text-content-muted">No admin users configured.</p>
        </div>
      )}

      {/* Add Admin Modal */}
      {showAdd && (
        <Modal title="Add Admin User" size="sm" onClose={() => setShowAdd(false)}>
          <form onSubmit={handleAdd} className="space-y-4">
            <div>
              <label className="label">Email Address</label>
              <input
                className="input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="user@example.com"
                required
              />
              <p className="mt-1 text-xs text-content-faint">This user will be able to sign in with Google.</p>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-secondary" onClick={() => setShowAdd(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={addAdmin.isPending}>
                {addAdmin.isPending ? 'Adding...' : 'Add Admin'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Delete Confirmation */}
      {showDelete && (
        <Modal title="Remove Admin" size="sm" onClose={() => setShowDelete(null)}>
          <p className="mb-4 text-sm text-content-muted">
            Remove admin access for <strong className="text-content-secondary">{showDelete}</strong>?
          </p>
          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={() => setShowDelete(null)}>Cancel</button>
            <button className="btn btn-danger" onClick={handleDelete} disabled={deleteAdmin.isPending}>
              {deleteAdmin.isPending ? 'Removing...' : 'Remove'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
