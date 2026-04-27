import { useState } from 'react';
import { toast } from 'sonner';
import { Modal } from './Modal';
import { type MiddlewareSpec, MIDDLEWARE_TYPES } from '../lib/types';

const inputCls = 'w-full rounded-lg border border-border bg-surface-base px-3 py-2 text-sm text-content-primary focus:border-brand-500 focus:outline-none';

/**
 * Form for adding or editing a single Traefik middleware spec. Type-aware:
 * switching the type picker swaps in a JSON template for that middleware kind.
 * The parent owns the mutation and toasts.
 */
export function MiddlewareEditor({
  initial,
  nameLocked,
  onClose,
  onSubmit,
}: {
  initial?: { name: string; spec: MiddlewareSpec };
  nameLocked?: boolean;
  onClose: () => void;
  onSubmit: (body: { name: string; spec: MiddlewareSpec }) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [type, setType] = useState<MiddlewareSpec['type']>(initial?.spec.type ?? 'headers');
  const [json, setJson] = useState(
    initial
      ? JSON.stringify(initial.spec, null, 2)
      : JSON.stringify({ type: 'headers', sts_seconds: 31536000 }, null, 2),
  );

  const submit = () => {
    if (!name.trim()) return toast.error('Name required');
    let parsed: any;
    try { parsed = JSON.parse(json); } catch (e: any) { return toast.error(`Invalid JSON: ${e?.message}`); }
    if (parsed.type !== type) parsed.type = type;
    onSubmit({ name, spec: parsed as MiddlewareSpec });
  };

  return (
    <Modal title={initial ? `Edit "${initial.name}"` : 'Add middleware'} onClose={onClose} size="xl">
      <div className="space-y-3 text-sm">
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-content-muted">Name</span>
          <input value={name} onChange={e => setName(e.target.value)} disabled={nameLocked || !!initial} className={inputCls} placeholder="my-rate-limit" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-content-muted">Type</span>
          <select
            value={type}
            onChange={e => {
              const t = e.target.value as MiddlewareSpec['type'];
              setType(t);
              setJson(JSON.stringify(templateFor(t), null, 2));
            }}
            className={inputCls}
          >
            {MIDDLEWARE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-content-muted">Spec (JSON)</span>
          <textarea value={json} onChange={e => setJson(e.target.value)} className={`${inputCls} font-mono text-xs`} rows={12} />
          <p className="mt-1 text-xs text-content-faint">Edit the JSON spec directly. See <code>docs/traefik.md</code> for each middleware type's fields.</p>
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="rounded-lg border border-border px-3 py-2 text-content-secondary hover:bg-surface-subtle">Cancel</button>
          <button onClick={submit} className="rounded-lg bg-brand-600 px-3 py-2 text-white hover:bg-brand-500">Save</button>
        </div>
      </div>
    </Modal>
  );
}

export function templateFor(type: MiddlewareSpec['type']): any {
  switch (type) {
    case 'rateLimit':       return { type, average: 100, burst: 200 };
    case 'basicAuth':       return { type, users: ['admin:$apr1$REPLACE'] };
    case 'forwardAuth':     return { type, address: 'http://auth/verify' };
    case 'ipAllowList':     return { type, source_range: ['10.0.0.0/8'] };
    case 'headers':         return { type, sts_seconds: 31536000, sts_include_subdomains: true, sts_preload: true };
    case 'redirectScheme':  return { type, scheme: 'https', permanent: true };
    case 'redirectRegex':   return { type, regex: '^http://(.+)$', replacement: 'https://$1', permanent: true };
    case 'compress':        return { type };
    case 'retry':           return { type, attempts: 3, initial_interval: '100ms' };
    case 'circuitBreaker':  return { type, expression: 'NetworkErrorRatio() > 0.5' };
    case 'replacePath':     return { type, path: '/new-path' };
    case 'replacePathRegex':return { type, regex: '^/old/(.*)', replacement: '/new/$1' };
    case 'inFlightReq':     return { type, amount: 50 };
    case 'chain':           return { type, middlewares: ['mw-a', 'mw-b'] };
  }
}
