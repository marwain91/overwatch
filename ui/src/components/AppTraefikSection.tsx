import { useState } from 'react';
import { toast } from 'sonner';
import { useAppTraefik, useUpdateAppTraefik } from '../hooks/useTraefik';
import type { MiddlewareSpec, TraefikApp } from '../lib/types';
import { MiddlewareEditor } from './MiddlewareEditor';

export function AppTraefikSection({ appId }: { appId: string }) {
  const { data, isLoading } = useAppTraefik(appId);
  const update = useUpdateAppTraefik(appId);
  const [editing, setEditing] = useState<{ name: string; spec: MiddlewareSpec } | null>(null);
  const [adding, setAdding] = useState(false);

  if (isLoading) return null;
  const traefik: TraefikApp = data ?? {};
  const middlewares = traefik.middlewares ?? {};
  const defaults = traefik.default_middlewares ?? [];

  const save = (next: TraefikApp) => {
    update.mutate(next, {
      onSuccess: () => toast.success('Saved. Existing tenants keep their snapshot — run Tenant Update to apply.'),
      onError: (err: any) => toast.error(err?.message || 'Save failed'),
    });
  };

  const upsertMw = (name: string, spec: MiddlewareSpec) => {
    save({ ...traefik, middlewares: { ...middlewares, [name]: spec } });
    setEditing(null); setAdding(false);
  };
  const removeMw = (name: string) => {
    if (!confirm(`Remove middleware "${name}" from this app?`)) return;
    const next = { ...middlewares };
    delete next[name];
    const dflt = defaults.filter(d => d !== name);
    save({ ...traefik, middlewares: next, default_middlewares: dflt });
  };
  const updateDefaults = (raw: string) => {
    const list = raw.split(',').map(s => s.trim()).filter(Boolean);
    save({ ...traefik, default_middlewares: list });
  };

  const entries = Object.entries(middlewares);

  return (
    <div className="card mb-4">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-content-secondary">Traefik</h2>
          <p className="text-xs text-content-faint">App-scoped middleware library and defaults applied to every service. Tenants run their frozen snapshot — run Tenant Update to pick up changes.</p>
        </div>
        <button onClick={() => setAdding(true)} className="rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-xs text-content-secondary hover:bg-surface-subtle">
          Add middleware
        </button>
      </div>

      <div className="space-y-2">
        {entries.length === 0 ? (
          <p className="text-sm text-content-muted">No app-scoped middlewares. Service routers can still reference middlewares from the global library.</p>
        ) : entries.map(([name, spec]) => (
          <div key={name} className="rounded-lg border border-border bg-surface-base p-3 text-sm">
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-content-primary">{name}</span>
                  <span className="rounded bg-surface-subtle px-2 py-0.5 text-xs text-content-muted">{spec.type}</span>
                </div>
                <pre className="mt-1 max-w-xl overflow-x-auto rounded bg-surface-raised p-2 text-xs text-content-muted">
                  {JSON.stringify(spec, null, 2)}
                </pre>
              </div>
              <div className="flex gap-2">
                <button onClick={() => setEditing({ name, spec })} className="text-xs text-content-muted hover:text-content-primary">Edit</button>
                <button onClick={() => removeMw(name)} className="text-xs text-red-400 hover:text-red-300">Remove</button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4">
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-content-muted">Default middlewares (applied to every service)</span>
          <input
            className="w-full rounded-lg border border-border bg-surface-base px-3 py-2 text-sm text-content-primary focus:border-brand-500 focus:outline-none"
            defaultValue={defaults.join(', ')}
            onBlur={e => {
              const next = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
              if (next.join(',') !== defaults.join(',')) updateDefaults(e.target.value);
            }}
            placeholder="hsts, my-rate-limit"
          />
          <p className="mt-1 text-xs text-content-faint">Comma-separated names from this app's library or the global library. Saved on blur.</p>
        </label>
      </div>

      {(editing || adding) && (
        <MiddlewareEditor
          initial={editing ?? undefined}
          onClose={() => { setEditing(null); setAdding(false); }}
          onSubmit={({ name, spec }) => upsertMw(name, spec)}
        />
      )}
    </div>
  );
}
