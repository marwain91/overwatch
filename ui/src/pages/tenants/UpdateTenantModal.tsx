import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useUpdateTenant } from '../../hooks/useTenants';
import { Modal } from '../../components/Modal';
import { TagInput } from '../../components/TagInput';
import { useWSStore } from '../../stores/wsStore';

type StepKey = 'manifest' | 'config' | 'pull' | 'restart';
type StepState = 'pending' | 'active' | 'completed' | 'skipped' | 'failed';

interface StepView {
  key: StepKey;
  label: string;
  state: StepState;
  detail?: string;
}

const STEP_LABELS: Record<StepKey, string> = {
  manifest: 'Read app manifest from image',
  config: 'Regenerate shared.env + docker-compose',
  pull: 'Pull images',
  restart: 'Start containers',
};

const INITIAL_STEPS: StepView[] = (Object.keys(STEP_LABELS) as StepKey[]).map(k => ({
  key: k,
  label: STEP_LABELS[k],
  state: 'pending',
}));

interface ProgressMsg {
  type: 'tenant:update:progress';
  data: {
    appId: string;
    tenantId: string;
    newTag: string;
    step: StepKey | 'done' | 'failed';
    status: 'started' | 'completed' | 'skipped' | 'failed';
    detail?: string;
  };
}

export function UpdateTenantModal({ appId, tenantId, currentVersion, onClose }: { appId: string; tenantId: string; currentVersion: string; onClose: () => void }) {
  const update = useUpdateTenant(appId);
  const [imageTag, setImageTag] = useState(currentVersion);
  const [steps, setSteps] = useState<StepView[]>(INITIAL_STEPS);
  const [overallError, setOverallError] = useState<string | null>(null);
  const subscribe = useWSStore((s) => s.subscribe);

  // Subscribe to WS progress for this tenant while the modal is open.
  useEffect(() => {
    return subscribe((raw) => {
      const msg = raw as ProgressMsg;
      if (msg.type !== 'tenant:update:progress') return;
      if (msg.data.appId !== appId || msg.data.tenantId !== tenantId) return;
      const { step, status, detail } = msg.data;

      if (step === 'done') return; // final, handled via mutation success
      if (step === 'failed') {
        setOverallError(detail || 'Update failed');
        return;
      }

      setSteps(prev => prev.map(s => {
        if (s.key !== step) return s;
        if (status === 'started') return { ...s, state: 'active', detail };
        if (status === 'completed') return { ...s, state: 'completed', detail };
        if (status === 'skipped') return { ...s, state: 'skipped', detail };
        if (status === 'failed') return { ...s, state: 'failed', detail };
        return s;
      }));
    });
  }, [appId, tenantId, subscribe]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSteps(INITIAL_STEPS);
    setOverallError(null);
    update.mutate({ tenantId, imageTag }, {
      onSuccess: () => { toast.success(`Tenant ${tenantId} updated`); onClose(); },
      onError: (err) => {
        // Error is already shown in the step list; just surface a toast too.
        toast.error(err.message);
      },
    });
  };

  return (
    <Modal title={`Update ${tenantId}`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="label">New Image Tag</label>
          <TagInput appId={appId} value={imageTag} onChange={setImageTag} />
        </div>

        {(update.isPending || update.isError) && (
          <div className="rounded border border-border bg-surface-raised p-3 space-y-2">
            <div className="text-xs uppercase tracking-wide text-content-tertiary">Progress</div>
            <ul className="space-y-1.5">
              {steps.map(s => (
                <li key={s.key} className="flex items-start gap-2 text-sm">
                  <StepIcon state={s.state} />
                  <div className="flex-1">
                    <div className={s.state === 'failed' ? 'text-red-400' : s.state === 'skipped' ? 'text-content-tertiary' : ''}>{s.label}</div>
                    {s.detail && (
                      <div className={'text-xs mt-0.5 ' + (s.state === 'failed' ? 'text-red-400' : 'text-content-faint')}>
                        {s.detail}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {overallError && (
              <div className="text-xs text-red-400 border-t border-border pt-2">
                {overallError}
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{update.isPending ? 'Close (update continues in background)' : 'Cancel'}</button>
          <button type="submit" className="btn btn-primary" disabled={update.isPending}>
            {update.isPending ? 'Updating...' : 'Update'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function StepIcon({ state }: { state: StepState }) {
  if (state === 'active') return <span className="mt-0.5 inline-block h-3 w-3 animate-spin rounded-full border-2 border-primary border-r-transparent" aria-label="in progress" />;
  if (state === 'completed') return <span className="mt-0.5 inline-block h-3 w-3 text-green-400" aria-label="done">✓</span>;
  if (state === 'skipped') return <span className="mt-0.5 inline-block h-3 w-3 text-content-tertiary" aria-label="skipped">–</span>;
  if (state === 'failed') return <span className="mt-0.5 inline-block h-3 w-3 text-red-400" aria-label="failed">✗</span>;
  return <span className="mt-0.5 inline-block h-3 w-3 rounded-full border border-border" aria-label="pending" />;
}
