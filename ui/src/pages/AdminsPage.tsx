import { useState } from 'react';
import { toast } from 'sonner';
import { Modal } from '../components/Modal';
import { useAdminUsers, useAddAdminUser, useSetAdminUserRole, useDeleteAdminUser } from '../hooks/useAdminUsers';
import { useCan } from '../hooks/useRole';
import type { AdminRole } from '../lib/types';

const ROLES: { value: AdminRole; hint: string }[] = [
  { value: 'viewer', hint: 'Read-only access' },
  { value: 'editor', hint: 'Can change tenants and settings, but not delete' },
  { value: 'admin', hint: 'Full access, including deletes and user management' },
];

export function AdminsPage() {
  const { data: admins, isLoading, error } = useAdminUsers();
  const isAdmin = useCan('admin');
  const addAdmin = useAddAdminUser();
  const setRole = useSetAdminUserRole();
  const deleteAdmin = useDeleteAdminUser();

  const [showAdd, setShowAdd] = useState(false);
  const [showDelete, setShowDelete] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [role, setNewRole] = useState<AdminRole>('viewer');

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    addAdmin.mutate({ email, role }, {
      onSuccess: () => {
        toast.success(`User ${email} added as ${role}`);
        setShowAdd(false);
        setEmail('');
        setNewRole('viewer');
      },
      onError: (err) => toast.error(err.message),
    });
  };

  const handleRoleChange = (userEmail: string, newRole: AdminRole) => {
    setRole.mutate({ email: userEmail, role: newRole }, {
      onSuccess: () => toast.success(`${userEmail} is now ${newRole}`),
      onError: (err) => toast.error(err.message),
    });
  };

  const handleDelete = () => {
    if (!showDelete) return;
    deleteAdmin.mutate(showDelete, {
      onSuccess: () => {
        toast.success(`User ${showDelete} removed`);
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
          <p className="mt-1 text-sm text-content-muted">Manage who can access this admin panel and what they can do.</p>
        </div>
        {isAdmin && (
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
            + Add User
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><span className="spinner" /></div>
      ) : error ? (
        <div className="card text-center py-12 text-red-400">
          Failed to load admin users: {error.message}
        </div>
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
              {isAdmin ? (
              <div className="flex items-center gap-2">
                <select
                  className="input w-auto py-1 text-xs"
                  aria-label={`Role for ${admin.email}`}
                  value={admin.role}
                  disabled={setRole.isPending && setRole.variables?.email === admin.email}
                  onChange={(e) => handleRoleChange(admin.email, e.target.value as AdminRole)}
                >
                  {ROLES.map((r) => <option key={r.value} value={r.value}>{r.value}</option>)}
                </select>
                <button className="btn btn-danger btn-xs" onClick={() => setShowDelete(admin.email)}>
                  Remove
                </button>
              </div>
              ) : (
                <span className="text-xs text-content-muted">{admin.role}</span>
              )}
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
        <Modal title="Add User" size="sm" onClose={() => setShowAdd(false)}>
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
            <div>
              <label className="label">Role</label>
              <select className="input" value={role} onChange={(e) => setNewRole(e.target.value as AdminRole)}>
                {ROLES.map((r) => <option key={r.value} value={r.value}>{r.value}</option>)}
              </select>
              <p className="mt-1 text-xs text-content-faint">{ROLES.find((r) => r.value === role)?.hint}</p>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-secondary" onClick={() => setShowAdd(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={addAdmin.isPending}>
                {addAdmin.isPending ? 'Adding...' : 'Add User'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Delete Confirmation */}
      {showDelete && (
        <Modal title="Remove user" size="sm" onClose={() => setShowDelete(null)}>
          <p className="mb-4 text-sm text-content-muted">
            Remove access for <strong className="text-content-secondary">{showDelete}</strong>?
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
