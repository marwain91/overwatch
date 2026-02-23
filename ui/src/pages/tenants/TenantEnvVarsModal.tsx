import { useState } from 'react';
import { toast } from 'sonner';
import { useTenantEnvVars, useSetTenantOverride, useResetTenantOverride } from '../../hooks/useTenants';
import { Modal } from '../../components/Modal';
import { cn } from '../../lib/cn';

export function TenantEnvVarsModal({ appId, tenantId, onClose }: { appId: string; tenantId: string; onClose: () => void }) {
  const { data: vars, isLoading } = useTenantEnvVars(appId, tenantId);
  const setOverride = useSetTenantOverride(appId);
  const resetOverride = useResetTenantOverride(appId);

  const [overrideKey, setOverrideKey] = useState<string | null>(null);
  const [overrideValue, setOverrideValue] = useState('');
  const [overrideSensitive, setOverrideSensitive] = useState(false);

  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newSensitive, setNewSensitive] = useState(false);

  const handleAdd = () => {
    if (!newKey.trim()) return;
    setOverride.mutate({ tenantId, key: newKey.trim(), value: newValue, sensitive: newSensitive }, {
      onSuccess: () => {
        toast.success(`Variable ${newKey.trim()} added`);
        setAdding(false);
        setNewKey('');
        setNewValue('');
        setNewSensitive(false);
      },
      onError: (err) => toast.error(err.message),
    });
  };

  const badgeClass = (source: string) =>
    source === 'tenant-only' ? 'badge-purple' : source === 'override' ? 'badge-blue' : 'badge-gray';

  return (
    <Modal title={`Env Vars: ${tenantId}`} size="xl" maxHeight onClose={onClose}>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs text-content-muted">{vars?.length ?? 0} variable{vars?.length !== 1 ? 's' : ''}</p>
        {!adding && (
          <button className="btn btn-primary btn-xs" onClick={() => setAdding(true)}>+ Add Variable</button>
        )}
      </div>

      {adding && (
        <div className="mb-4 rounded border border-border-subtle bg-surface-muted p-3 space-y-2">
          <p className="text-sm font-medium text-content-secondary">New tenant-only variable</p>
          <input className="input" value={newKey} onChange={(e) => setNewKey(e.target.value.toUpperCase())} placeholder="KEY_NAME" />
          <input className="input" value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder="Value" />
          <label className="flex items-center gap-2 text-sm text-content-secondary">
            <input type="checkbox" checked={newSensitive} onChange={(e) => setNewSensitive(e.target.checked)} />
            Sensitive
          </label>
          <div className="flex gap-2">
            <button className="btn btn-primary btn-sm" onClick={handleAdd} disabled={!newKey.trim() || setOverride.isPending}>Add</button>
            <button className="btn btn-secondary btn-sm" onClick={() => { setAdding(false); setNewKey(''); setNewValue(''); setNewSensitive(false); }}>Cancel</button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-8"><span className="spinner" /></div>
      ) : vars && vars.length > 0 ? (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          {vars.map((v) => (
            <div key={v.key} className="flex items-center justify-between rounded border border-border-subtle bg-surface-muted px-3 py-2">
              <div>
                <span className="text-sm font-mono text-content-secondary">{v.key}</span>
                <span className={cn('ml-2 badge', badgeClass(v.source))}>{v.source}</span>
                <p className="mt-0.5 text-xs text-content-faint font-mono">{v.sensitive ? '••••••' : v.value}</p>
              </div>
              <div className="flex gap-1">
                {v.source === 'global' && (
                  <button className="btn btn-secondary btn-xs" onClick={() => { setOverrideKey(v.key); setOverrideValue(v.sensitive ? '' : v.value); setOverrideSensitive(v.sensitive); }}>Override</button>
                )}
                {v.source === 'override' && (
                  <>
                    <button className="btn btn-secondary btn-xs" onClick={() => { setOverrideKey(v.key); setOverrideValue(v.sensitive ? '' : v.value); setOverrideSensitive(v.sensitive); }}>Edit</button>
                    <button className="btn btn-danger btn-xs" onClick={() => resetOverride.mutate({ tenantId, key: v.key }, {
                      onSuccess: () => toast.success(`Override for ${v.key} reset`),
                      onError: (err) => toast.error(err.message),
                    })}>Reset</button>
                  </>
                )}
                {v.source === 'tenant-only' && (
                  <>
                    <button className="btn btn-secondary btn-xs" onClick={() => { setOverrideKey(v.key); setOverrideValue(v.sensitive ? '' : v.value); setOverrideSensitive(v.sensitive); }}>Edit</button>
                    <button className="btn btn-danger btn-xs" onClick={() => resetOverride.mutate({ tenantId, key: v.key }, {
                      onSuccess: () => toast.success(`Variable ${v.key} removed`),
                      onError: (err) => toast.error(err.message),
                    })}>Remove</button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-content-muted">No environment variables configured.</p>
      )}

      {overrideKey && (
        <div className="mt-4 border-t border-border-subtle pt-4">
          <p className="mb-2 text-sm text-content-tertiary">Override: <strong>{overrideKey}</strong></p>
          <input className="input mb-2" value={overrideValue} onChange={(e) => setOverrideValue(e.target.value)} placeholder="New value" />
          <label className="flex items-center gap-2 mb-2 text-sm text-content-secondary">
            <input type="checkbox" checked={overrideSensitive} onChange={(e) => setOverrideSensitive(e.target.checked)} />
            Sensitive
          </label>
          <div className="flex gap-2">
            <button className="btn btn-primary btn-sm" onClick={() => setOverride.mutate({ tenantId, key: overrideKey, value: overrideValue, sensitive: overrideSensitive }, {
              onSuccess: () => { toast.success('Override saved'); setOverrideKey(null); },
              onError: (err) => toast.error(err.message),
            })} disabled={setOverride.isPending}>Save</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setOverrideKey(null)}>Cancel</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
