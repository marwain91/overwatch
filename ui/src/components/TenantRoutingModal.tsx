import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Modal } from './Modal';
import { useApp } from '../hooks/useApps';
import { useTenantTraefik, useUpdateTenantTraefik, useCertResolvers } from '../hooks/useTraefik';
import type { TraefikTenant, TlsTermination } from '../lib/types';

const inputCls = 'w-full rounded-lg border border-border bg-surface-base px-3 py-2 text-sm text-content-primary focus:border-brand-500 focus:outline-none';

/**
 * Per-tenant Traefik overrides — cert resolver, host aliases, per-service
 * middleware overrides, TLS termination override. Backed by /api/apps/:id/tenants/:tid/traefik.
 *
 * Note: middleware_overrides REPLACE the app's chain for that service (not merge).
 */
export function TenantRoutingModal({
  appId, tenantId, onClose,
}: {
  appId: string;
  tenantId: string;
  onClose: () => void;
}) {
  const { data: app } = useApp(appId);
  const { data: existing, isLoading } = useTenantTraefik(appId, tenantId);
  const { data: resolvers } = useCertResolvers();
  const update = useUpdateTenantTraefik(appId, tenantId);

  const services = (app?.services ?? []).filter(s => !s.is_init_container);

  const [certResolver, setCertResolver] = useState('');
  const [hostAliases, setHostAliases] = useState('');
  const [tlsTermination, setTlsTermination] = useState<'inherit' | TlsTermination>('inherit');
  const [middlewareOverrides, setMiddlewareOverrides] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (loaded || isLoading) return;
    if (existing) {
      setCertResolver(existing.cert_resolver ?? '');
      setHostAliases((existing.host_aliases ?? []).join(', '));
      setTlsTermination(existing.tls_termination ?? 'inherit');
      const initialOverrides: Record<string, string> = {};
      for (const [svc, names] of Object.entries(existing.middleware_overrides ?? {})) {
        initialOverrides[svc] = names.join(', ');
      }
      setMiddlewareOverrides(initialOverrides);
    }
    setLoaded(true);
  }, [existing, isLoading, loaded]);

  const submit = () => {
    const aliases = hostAliases.split(',').map(s => s.trim()).filter(Boolean);
    const mwOverrides: Record<string, string[]> = {};
    for (const [svc, raw] of Object.entries(middlewareOverrides)) {
      const list = raw.split(',').map(s => s.trim()).filter(Boolean);
      if (list.length > 0) mwOverrides[svc] = list;
    }
    const body: TraefikTenant = {};
    if (certResolver.trim()) body.cert_resolver = certResolver.trim();
    if (aliases.length > 0) body.host_aliases = aliases;
    if (tlsTermination !== 'inherit') body.tls_termination = tlsTermination;
    if (Object.keys(mwOverrides).length > 0) body.middleware_overrides = mwOverrides;

    // Empty body deletes the override file (server handles).
    const payload = Object.keys(body).length === 0 ? null : body;
    update.mutate(payload, {
      onSuccess: () => { toast.success('Routing saved. Run `tenant restart` to apply.'); onClose(); },
      onError: (err: any) => toast.error(err?.message || 'Save failed'),
    });
  };

  return (
    <Modal title={`Routing — ${appId}/${tenantId}`} onClose={onClose} size="xl" maxHeight>
      <div className="flex-1 overflow-y-auto pr-1">
        <div className="space-y-4 text-sm">
          <Field label="Cert resolver override">
            {resolvers && resolvers.length > 0 ? (
              <select value={certResolver} onChange={e => setCertResolver(e.target.value)} className={inputCls}>
                <option value="">— inherit (auto-match by domain) —</option>
                {resolvers.map(r => <option key={r.name} value={r.name}>{r.name} ({r.challenge})</option>)}
              </select>
            ) : (
              <input value={certResolver} onChange={e => setCertResolver(e.target.value)} className={inputCls} placeholder="leave empty to inherit" />
            )}
            <p className="mt-1 text-xs text-content-faint">Leave empty to use the global pattern-matching rules.</p>
          </Field>

          <Field label="Host aliases">
            <input value={hostAliases} onChange={e => setHostAliases(e.target.value)} className={inputCls} placeholder="legacy.acme.com, alt.acme.com" />
            <p className="mt-1 text-xs text-content-faint">Additional <code>Host(...)</code> matchers for this tenant's primary service.</p>
          </Field>

          <Field label="TLS termination">
            <select value={tlsTermination} onChange={e => setTlsTermination(e.target.value as any)} className={inputCls}>
              <option value="inherit">Inherit (use app/global default)</option>
              <option value="traefik">Traefik (manage certs here)</option>
              <option value="upstream">Upstream proxy (TLS terminates before Traefik)</option>
            </select>
            {tlsTermination === 'upstream' && (
              <div className="mt-2 rounded-md bg-amber-600/10 p-2 text-xs text-amber-300">
                The upstream entrypoint must have <code>forwarded_headers.trusted_ips</code> configured (Infrastructure → Traefik → Entrypoints) or apps see the upstream's IP, not the real client.
              </div>
            )}
          </Field>

          <div>
            <span className="mb-2 block text-xs font-medium uppercase tracking-wider text-content-muted">Middleware overrides per service</span>
            <p className="mb-2 text-xs text-content-faint">
              <strong>Replaces</strong> the app's middleware chain for that service (does not merge). Leave empty to inherit. Names come from this app's library or the global library.
            </p>
            <div className="space-y-2">
              {services.length === 0 ? (
                <p className="text-xs text-content-muted">App has no routable services.</p>
              ) : services.map(svc => (
                <label key={svc.name} className="block rounded-lg border border-border bg-surface-base p-2">
                  <span className="block text-xs text-content-muted">{svc.name}</span>
                  <input
                    value={middlewareOverrides[svc.name] ?? ''}
                    onChange={e => setMiddlewareOverrides(prev => ({ ...prev, [svc.name]: e.target.value }))}
                    className={inputCls}
                    placeholder="strict-rl, ip-corp"
                  />
                </label>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 flex justify-between gap-2 border-t border-border pt-3">
        <button onClick={onClose} className="rounded-lg border border-border px-3 py-2 text-content-secondary hover:bg-surface-subtle">Cancel</button>
        <button onClick={submit} className="rounded-lg bg-brand-600 px-3 py-2 text-white hover:bg-brand-500" disabled={update.isPending}>
          {update.isPending ? 'Saving...' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-content-muted">{label}</span>
      {children}
    </label>
  );
}
