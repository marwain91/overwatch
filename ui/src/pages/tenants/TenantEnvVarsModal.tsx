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

  return (
    <Modal title={`Env Vars: ${tenantId}`} size="xl" maxHeight onClose={onClose}>
      {isLoading ? (
        <div className="flex justify-center py-8"><span className="spinner" /></div>
      ) : vars && vars.length > 0 ? (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          {vars.map((v) => (
            <div key={v.key} className="flex items-center justify-between rounded border border-border-subtle bg-surface-muted px-3 py-2">
              <div>
                <span className="text-sm font-mono text-content-secondary">{v.key}</span>
                <span className={cn('ml-2 badge', v.source === 'override' ? 'badge-blue' : 'badge-gray')}>{v.source}</span>
                <p className="mt-0.5 text-xs text-content-faint font-mono">{v.sensitive ? '••••••' : v.value}</p>
              </div>
              <div className="flex gap-1">
                <button className="btn btn-secondary btn-xs" onClick={() => { setOverrideKey(v.key); setOverrideValue(v.sensitive ? '' : v.value); }}>Override</button>
                {v.source === 'override' && (
                  <button className="btn btn-danger btn-xs" onClick={() => resetOverride.mutate({ tenantId, key: v.key }, {
                    onSuccess: () => toast.success(`Override for ${v.key} reset`),
                    onError: (err) => toast.error(err.message),
                  })}>Reset</button>
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
          <div className="flex gap-2">
            <button className="btn btn-primary btn-sm" onClick={() => setOverride.mutate({ tenantId, key: overrideKey, value: overrideValue, sensitive: false }, {
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
