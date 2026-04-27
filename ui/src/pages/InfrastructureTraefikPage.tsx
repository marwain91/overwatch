import { useState } from 'react';
import { toast } from 'sonner';
import { Modal } from '../components/Modal';
import { cn } from '../lib/cn';
import {
  useTraefik, useUpdateTraefik,
  useCertResolvers, useUpsertCertResolver, useDeleteCertResolver,
  useGlobalMiddlewares, useUpsertGlobalMiddleware, useDeleteGlobalMiddleware,
  useDashboardConfig, useUpdateDashboard,
  useOverwatchRouting, useUpdateOverwatchRouting,
  useReloadTraefik,
} from '../hooks/useTraefik';
import {
  CertResolver, CertResolverDns, CertResolverHttp, Entrypoint, MiddlewareSpec,
  TraefikDashboard, TraefikGlobal, TraefikOverwatchRouting, TlsTermination,
} from '../lib/types';
import { MiddlewareEditor } from '../components/MiddlewareEditor';

type Tab = 'resolvers' | 'middlewares' | 'entrypoints' | 'dashboard' | 'overwatch';

export function InfrastructureTraefikPage() {
  const [tab, setTab] = useState<Tab>('resolvers');
  const reload = useReloadTraefik();
  const [reloadOpen, setReloadOpen] = useState(false);

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'resolvers',    label: 'Cert Resolvers' },
    { id: 'middlewares',  label: 'Middlewares' },
    { id: 'entrypoints',  label: 'Entrypoints' },
    { id: 'dashboard',    label: 'Dashboard' },
    { id: 'overwatch',    label: 'Overwatch Server' },
  ];

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-content-primary">Traefik Configuration</h1>
          <p className="mt-1 text-sm text-content-muted">
            Cert resolvers, middlewares, dashboard, and Overwatch self-routing. Changes that affect cert resolvers, the dashboard, or Overwatch routing require a Traefik restart.
          </p>
        </div>
        <button
          onClick={() => setReloadOpen(true)}
          className="rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-content-secondary hover:bg-surface-subtle"
        >
          Reload Traefik
        </button>
      </div>

      <div className="mb-4 flex gap-1 border-b border-border">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'border-b-2 px-3 py-2 text-sm transition-colors',
              tab === t.id
                ? 'border-brand-500 text-content-primary'
                : 'border-transparent text-content-muted hover:text-content-secondary',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <TlsTerminationBanner />

      {tab === 'resolvers'    && <CertResolversTab />}
      {tab === 'middlewares'  && <MiddlewaresTab />}
      {tab === 'entrypoints'  && <EntrypointsTab />}
      {tab === 'dashboard'    && <DashboardTab />}
      {tab === 'overwatch'    && <OverwatchTab />}

      {reloadOpen && (
        <Modal title="Reload Traefik?" onClose={() => setReloadOpen(false)} size="md">
          <p className="text-sm text-content-secondary">
            Restarting Traefik will briefly pause routing for all tenants (~5–10s). Required after cert resolver, entrypoint, or dashboard config changes.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              onClick={() => setReloadOpen(false)}
              className="rounded-lg border border-border px-3 py-2 text-sm text-content-secondary hover:bg-surface-subtle"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                reload.mutate(undefined, {
                  onSuccess: () => { toast.success('Traefik restarted'); setReloadOpen(false); },
                  onError: (err: any) => toast.error(err?.message || 'Reload failed'),
                });
              }}
              disabled={reload.isPending}
              className="rounded-lg bg-brand-600 px-3 py-2 text-sm text-white hover:bg-brand-500 disabled:opacity-50"
            >
              {reload.isPending ? 'Restarting...' : 'Restart Now'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Cert resolvers ────────────────────────────────────────────────────────

function CertResolversTab() {
  const { data, isLoading } = useCertResolvers();
  const upsert = useUpsertCertResolver();
  const del = useDeleteCertResolver();
  const [editing, setEditing] = useState<CertResolver | null>(null);
  const [adding, setAdding] = useState(false);

  if (isLoading) return <p className="text-sm text-content-muted">Loading...</p>;
  const resolvers = data ?? [];

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <button
          onClick={() => setAdding(true)}
          className="rounded-lg bg-brand-600 px-3 py-2 text-sm text-white hover:bg-brand-500"
        >
          Add resolver
        </button>
      </div>

      {resolvers.length === 0 ? (
        <p className="text-sm text-content-muted">No cert resolvers configured.</p>
      ) : (
        <div className="space-y-2">
          {resolvers.map(r => (
            <div key={r.name} className="rounded-lg border border-border bg-surface-raised p-3">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-content-primary">{r.name}</span>
                    <span className="rounded bg-surface-subtle px-2 py-0.5 text-xs text-content-muted">{r.challenge.toUpperCase()}</span>
                  </div>
                  <div className="mt-1 text-xs text-content-muted">
                    {r.challenge === 'dns' ? `provider: ${r.provider}` : `entrypoint: ${r.entrypoint ?? 'web'}`}
                    {r.acme_email && <span> · acme_email: {r.acme_email}</span>}
                  </div>
                  {r.domain_patterns && r.domain_patterns.length > 0 && (
                    <div className="mt-1 text-xs text-content-faint">patterns: {r.domain_patterns.join(', ')}</div>
                  )}
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setEditing(r)} className="text-xs text-content-muted hover:text-content-primary">Edit</button>
                  <button
                    onClick={() => {
                      if (confirm(`Delete cert resolver "${r.name}"?`)) {
                        del.mutate(r.name, {
                          onSuccess: () => toast.success(`Deleted ${r.name}`),
                          onError: (err: any) => toast.error(err?.message || 'Delete failed'),
                        });
                      }
                    }}
                    className="text-xs text-red-400 hover:text-red-300"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {(editing || adding) && (
        <CertResolverModal
          initial={editing ?? undefined}
          onClose={() => { setEditing(null); setAdding(false); }}
          onSubmit={(body) => {
            upsert.mutate({ name: body.name, body }, {
              onSuccess: () => {
                toast.success(`${editing ? 'Updated' : 'Added'} ${body.name}`);
                setEditing(null); setAdding(false);
              },
              onError: (err: any) => toast.error(err?.message || 'Save failed'),
            });
          }}
        />
      )}
    </div>
  );
}

function CertResolverModal({
  initial, onClose, onSubmit,
}: {
  initial?: CertResolver;
  onClose: () => void;
  onSubmit: (body: CertResolver) => void;
}) {
  const [challenge, setChallenge] = useState<'dns' | 'http'>(initial?.challenge ?? 'dns');
  const [name, setName] = useState(initial?.name ?? '');
  const [provider, setProvider] = useState(initial?.challenge === 'dns' ? initial.provider : 'cloudflare');
  const [entrypoint, setEntrypoint] = useState(initial?.challenge === 'http' ? (initial.entrypoint ?? 'web') : 'web');
  const [acmeEmail, setAcmeEmail] = useState(initial?.acme_email ?? '');
  const [domainPatterns, setDomainPatterns] = useState((initial?.domain_patterns ?? []).join(', '));
  const [envPairs, setEnvPairs] = useState(
    initial?.challenge === 'dns' && initial.env
      ? Object.entries(initial.env).map(([k, v]) => `${k}=${v}`).join(', ')
      : '',
  );

  const submit = () => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return toast.error('Name: lowercase, digits, dashes');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(acmeEmail)) return toast.error('Invalid acme_email');
    const patterns = domainPatterns.split(',').map(s => s.trim()).filter(Boolean);
    if (challenge === 'dns') {
      const env: Record<string, string> = {};
      for (const pair of envPairs.split(',').map(s => s.trim()).filter(Boolean)) {
        const [k, v] = pair.split('=');
        if (k && v) env[k.trim()] = v.trim();
      }
      const body: CertResolverDns = {
        name, challenge: 'dns', provider, acme_email: acmeEmail,
        env: Object.keys(env).length > 0 ? env : undefined,
        domain_patterns: patterns.length > 0 ? patterns : undefined,
      };
      onSubmit(body);
    } else {
      const body: CertResolverHttp = {
        name, challenge: 'http', acme_email: acmeEmail, entrypoint,
        domain_patterns: patterns.length > 0 ? patterns : undefined,
      };
      onSubmit(body);
    }
  };

  return (
    <Modal title={initial ? `Edit "${initial.name}"` : 'Add cert resolver'} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <Field label="Challenge type">
          <select value={challenge} onChange={e => setChallenge(e.target.value as any)} className={inputCls} disabled={!!initial}>
            <option value="dns">DNS-01 (required for wildcard)</option>
            <option value="http">HTTP-01</option>
          </select>
        </Field>
        <Field label="Name">
          <input value={name} onChange={e => setName(e.target.value)} disabled={!!initial} className={inputCls} placeholder="cf-prod" />
        </Field>
        <Field label="ACME email">
          <input value={acmeEmail} onChange={e => setAcmeEmail(e.target.value)} className={inputCls} placeholder="ops@example.com" />
        </Field>
        {challenge === 'dns' ? (
          <>
            <Field label="DNS provider">
              <input value={provider} onChange={e => setProvider(e.target.value)} className={inputCls} placeholder="cloudflare" />
              <p className="mt-1 text-xs text-content-faint">Any string Traefik supports (cloudflare, gandi, route53, hetzner, ...)</p>
            </Field>
            <Field label="Provider env vars">
              <input value={envPairs} onChange={e => setEnvPairs(e.target.value)} className={inputCls} placeholder="CF_DNS_API_TOKEN=${CF_TOKEN}" />
              <p className="mt-1 text-xs text-content-faint">Comma-separated KEY=${'${VAR}'} pairs.</p>
            </Field>
          </>
        ) : (
          <Field label="Entrypoint">
            <input value={entrypoint} onChange={e => setEntrypoint(e.target.value)} className={inputCls} placeholder="web" />
          </Field>
        )}
        <Field label="Domain patterns">
          <input value={domainPatterns} onChange={e => setDomainPatterns(e.target.value)} className={inputCls} placeholder="*.app.example.com, *.example.eu" />
          <p className="mt-1 text-xs text-content-faint">Comma-separated globs. Tenants whose domain matches any pattern auto-pick this resolver.</p>
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="rounded-lg border border-border px-3 py-2 text-content-secondary hover:bg-surface-subtle">Cancel</button>
          <button onClick={submit} className="rounded-lg bg-brand-600 px-3 py-2 text-white hover:bg-brand-500">Save</button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Middlewares ───────────────────────────────────────────────────────────

function MiddlewaresTab() {
  const { data, isLoading } = useGlobalMiddlewares();
  const upsert = useUpsertGlobalMiddleware();
  const del = useDeleteGlobalMiddleware();
  const [editing, setEditing] = useState<{ name: string; spec: MiddlewareSpec } | null>(null);
  const [adding, setAdding] = useState(false);

  if (isLoading) return <p className="text-sm text-content-muted">Loading...</p>;
  const middlewares = data ?? {};
  const entries = Object.entries(middlewares);

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <button onClick={() => setAdding(true)} className="rounded-lg bg-brand-600 px-3 py-2 text-sm text-white hover:bg-brand-500">
          Add middleware
        </button>
      </div>

      {entries.length === 0 ? (
        <p className="text-sm text-content-muted">No global middlewares defined.</p>
      ) : (
        <div className="space-y-2">
          {entries.map(([name, spec]) => (
            <div key={name} className="rounded-lg border border-border bg-surface-raised p-3">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-content-primary">{name}</span>
                    <span className="rounded bg-surface-subtle px-2 py-0.5 text-xs text-content-muted">{spec.type}</span>
                  </div>
                  <pre className="mt-1 max-w-2xl overflow-x-auto rounded bg-surface-base p-2 text-xs text-content-muted">
                    {JSON.stringify(spec, null, 2)}
                  </pre>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setEditing({ name, spec })} className="text-xs text-content-muted hover:text-content-primary">Edit</button>
                  <button
                    onClick={() => {
                      if (confirm(`Delete middleware "${name}"?`)) {
                        del.mutate(name, {
                          onSuccess: () => toast.success(`Deleted ${name}`),
                          onError: (err: any) => toast.error(err?.message || 'Delete failed'),
                        });
                      }
                    }}
                    className="text-xs text-red-400 hover:text-red-300"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {(editing || adding) && (
        <MiddlewareEditor
          initial={editing ?? undefined}
          onClose={() => { setEditing(null); setAdding(false); }}
          onSubmit={({ name, spec }) => {
            upsert.mutate({ name, body: spec }, {
              onSuccess: () => {
                toast.success(`${editing ? 'Updated' : 'Added'} ${name}`);
                setEditing(null); setAdding(false);
              },
              onError: (err: any) => toast.error(err?.message || 'Save failed'),
            });
          }}
        />
      )}
    </div>
  );
}

// ─── Dashboard tab ─────────────────────────────────────────────────────────

function DashboardTab() {
  const { data, isLoading } = useDashboardConfig();
  const update = useUpdateDashboard();
  const [host, setHost] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [certResolver, setCertResolver] = useState('');
  const [middlewares, setMiddlewares] = useState('');
  const [loaded, setLoaded] = useState(false);

  if (isLoading) return <p className="text-sm text-content-muted">Loading...</p>;
  if (!loaded && data !== undefined) {
    if (data) {
      setHost(data.host ?? '');
      setEnabled(data.enabled);
      setCertResolver(data.cert_resolver ?? '');
      setMiddlewares((data.middlewares ?? []).join(', '));
    }
    setLoaded(true);
  }

  const submit = () => {
    const body: TraefikDashboard = {
      enabled,
      host: host || undefined,
      cert_resolver: certResolver || undefined,
      middlewares: middlewares.split(',').map(s => s.trim()).filter(Boolean),
    };
    if (body.middlewares && body.middlewares.length === 0) delete body.middlewares;
    update.mutate(body, {
      onSuccess: () => toast.success('Dashboard config saved'),
      onError: (err: any) => toast.error(err?.message || 'Save failed'),
    });
  };

  return (
    <div className="max-w-2xl space-y-3 text-sm">
      <Field label="Enabled">
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
      </Field>
      <Field label="Host">
        <input value={host} onChange={e => setHost(e.target.value)} className={inputCls} placeholder="traefik.example.com" />
      </Field>
      <Field label="Cert resolver">
        <input value={certResolver} onChange={e => setCertResolver(e.target.value)} className={inputCls} placeholder="cf-prod" />
      </Field>
      <Field label="Middlewares">
        <input value={middlewares} onChange={e => setMiddlewares(e.target.value)} className={inputCls} placeholder="admin-auth, hsts" />
        <p className="mt-1 text-xs text-content-faint">Comma-separated names from the global middleware library.</p>
      </Field>
      <div className="pt-2">
        <button onClick={submit} className="rounded-lg bg-brand-600 px-3 py-2 text-white hover:bg-brand-500">Save</button>
      </div>
    </div>
  );
}

// ─── Overwatch self-routing tab ────────────────────────────────────────────

function OverwatchTab() {
  const { data, isLoading } = useOverwatchRouting();
  const update = useUpdateOverwatchRouting();
  const [host, setHost] = useState('');
  const [certResolver, setCertResolver] = useState('');
  const [middlewares, setMiddlewares] = useState('');
  const [loaded, setLoaded] = useState(false);

  if (isLoading) return <p className="text-sm text-content-muted">Loading...</p>;
  if (!loaded && data !== undefined) {
    if (data) {
      setHost(data.host);
      setCertResolver(data.cert_resolver ?? '');
      setMiddlewares((data.middlewares ?? []).join(', '));
    }
    setLoaded(true);
  }

  const submit = () => {
    if (!host.trim()) return toast.error('Host required');
    const body: TraefikOverwatchRouting = {
      host,
      cert_resolver: certResolver || undefined,
      middlewares: middlewares.split(',').map(s => s.trim()).filter(Boolean),
    };
    if (body.middlewares && body.middlewares.length === 0) delete body.middlewares;
    update.mutate(body, {
      onSuccess: () => toast.success('Saved. Run `overwatch infra deploy` to regenerate the Overwatch compose file.'),
      onError: (err: any) => toast.error(err?.message || 'Save failed'),
    });
  };

  return (
    <div className="max-w-2xl space-y-3 text-sm">
      <p className="text-xs text-content-faint">
        Routing for the Overwatch admin server itself. Replaces the hardcoded labels in the legacy template. Changes apply on the next <code>overwatch infra deploy</code>.
      </p>
      <Field label="Host">
        <input value={host} onChange={e => setHost(e.target.value)} className={inputCls} placeholder="overwatch.example.com" />
      </Field>
      <Field label="Cert resolver">
        <input value={certResolver} onChange={e => setCertResolver(e.target.value)} className={inputCls} placeholder="cf-prod" />
      </Field>
      <Field label="Middlewares">
        <input value={middlewares} onChange={e => setMiddlewares(e.target.value)} className={inputCls} placeholder="admin-auth" />
        <p className="mt-1 text-xs text-content-faint">Comma-separated names from the global middleware library.</p>
      </Field>
      <div className="pt-2">
        <button onClick={submit} className="rounded-lg bg-brand-600 px-3 py-2 text-white hover:bg-brand-500">Save</button>
      </div>
    </div>
  );
}

// ─── TLS termination banner (global setting) ──────────────────────────────

function TlsTerminationBanner() {
  const { data, isLoading } = useTraefik();
  const update = useUpdateTraefik();
  const [editing, setEditing] = useState(false);

  if (isLoading || !data) return null;
  const termination: TlsTermination = data.tls_termination ?? 'traefik';
  const upstreamEp = data.upstream_entrypoint ?? 'web';

  const summary = termination === 'traefik'
    ? 'Traefik terminates TLS using the configured cert resolvers.'
    : `An upstream proxy terminates TLS. Traefik routes plain HTTP via the "${upstreamEp}" entrypoint.`;

  return (
    <div className="mb-4 rounded-lg border border-border bg-surface-subtle p-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-content-muted">TLS termination</span>
            <span className={cn(
              'rounded px-2 py-0.5 text-xs',
              termination === 'traefik' ? 'bg-brand-600/20 text-brand-300' : 'bg-amber-600/20 text-amber-300',
            )}>
              {termination === 'traefik' ? 'Traefik' : 'Upstream proxy'}
            </span>
          </div>
          <p className="mt-1 text-content-muted">{summary}</p>
        </div>
        <button onClick={() => setEditing(true)} className="text-xs text-content-muted hover:text-content-primary">Change</button>
      </div>
      {editing && (
        <TlsTerminationModal
          initial={{ tls_termination: termination, upstream_entrypoint: upstreamEp }}
          fullConfig={data}
          onClose={() => setEditing(false)}
          onSubmit={(patch) => {
            const next: TraefikGlobal = { ...data, ...patch };
            update.mutate(next, {
              onSuccess: () => { toast.success('TLS termination updated. Run Reload Traefik for entrypoint changes to take effect.'); setEditing(false); },
              onError: (err: any) => toast.error(err?.message || 'Save failed'),
            });
          }}
        />
      )}
    </div>
  );
}

function TlsTerminationModal({
  initial, fullConfig, onClose, onSubmit,
}: {
  initial: { tls_termination: TlsTermination; upstream_entrypoint: string };
  fullConfig: TraefikGlobal;
  onClose: () => void;
  onSubmit: (patch: Partial<TraefikGlobal>) => void;
}) {
  const [termination, setTermination] = useState<TlsTermination>(initial.tls_termination);
  const [upstreamEp, setUpstreamEp] = useState(initial.upstream_entrypoint);
  const knownEntrypoints = (fullConfig.entrypoints ?? []).map(e => e.name);

  return (
    <Modal title="TLS termination" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <Field label="Mode">
          <select value={termination} onChange={e => setTermination(e.target.value as TlsTermination)} className={inputCls}>
            <option value="traefik">Traefik (default — Traefik manages certs)</option>
            <option value="upstream">Upstream proxy (TLS terminates before Traefik)</option>
          </select>
        </Field>
        {termination === 'upstream' && (
          <Field label="Upstream entrypoint">
            <input
              value={upstreamEp}
              onChange={e => setUpstreamEp(e.target.value)}
              className={inputCls}
              placeholder="web"
              list="known-entrypoints"
            />
            <datalist id="known-entrypoints">
              {knownEntrypoints.map(n => <option key={n} value={n} />)}
            </datalist>
            <p className="mt-1 text-xs text-content-faint">
              Name of the entrypoint Traefik listens on (no TLS). Make sure it has <code>forwarded_headers.trusted_ips</code> configured (Entrypoints tab) so Traefik trusts X-Forwarded-* from your upstream.
            </p>
          </Field>
        )}
        {termination === 'upstream' && (
          <div className="rounded-md bg-amber-600/10 p-2 text-xs text-amber-300">
            Apps will see the request scheme/IP via X-Forwarded-* headers. If the upstream entrypoint doesn't trust the upstream's IP, headers are dropped and apps see the upstream as the client.
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="rounded-lg border border-border px-3 py-2 text-content-secondary hover:bg-surface-subtle">Cancel</button>
          <button
            onClick={() => onSubmit({
              tls_termination: termination,
              upstream_entrypoint: termination === 'upstream' ? (upstreamEp || 'web') : undefined,
            })}
            className="rounded-lg bg-brand-600 px-3 py-2 text-white hover:bg-brand-500"
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Entrypoints tab ───────────────────────────────────────────────────────

function EntrypointsTab() {
  const { data, isLoading } = useTraefik();
  const update = useUpdateTraefik();
  const [editing, setEditing] = useState<Entrypoint | null>(null);
  const [adding, setAdding] = useState(false);

  if (isLoading || !data) return <p className="text-sm text-content-muted">Loading...</p>;
  const entrypoints = data.entrypoints ?? [
    { name: 'web', port: 80, redirect_to: 'websecure' },
    { name: 'websecure', port: 443 },
  ];

  const save = (next: Entrypoint[]) => {
    const patch: TraefikGlobal = { ...data, entrypoints: next };
    update.mutate(patch, {
      onSuccess: () => toast.success('Saved. Run Reload Traefik for entrypoint changes to take effect.'),
      onError: (err: any) => toast.error(err?.message || 'Save failed'),
    });
  };

  return (
    <div>
      <p className="mb-3 text-xs text-content-faint">
        Entrypoints define the ports Traefik listens on. Configure <code>forwarded_headers</code> when sitting behind Cloudflare / ALB / nginx etc., or <code>proxy_protocol</code> for HAProxy / NLB.
      </p>
      <div className="mb-4 flex justify-end">
        <button onClick={() => setAdding(true)} className="rounded-lg bg-brand-600 px-3 py-2 text-sm text-white hover:bg-brand-500">
          Add entrypoint
        </button>
      </div>

      <div className="space-y-2">
        {entrypoints.map(ep => (
          <div key={ep.name} className="rounded-lg border border-border bg-surface-raised p-3">
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-content-primary">{ep.name}</span>
                  <span className="rounded bg-surface-subtle px-2 py-0.5 text-xs text-content-muted">:{ep.port}</span>
                  {ep.redirect_to && <span className="text-xs text-content-faint">→ {ep.redirect_to}</span>}
                </div>
                {ep.forwarded_headers && (
                  <div className="mt-1 text-xs text-content-muted">trust X-Forwarded-* from: {ep.forwarded_headers.trusted_ips.join(', ')}</div>
                )}
                {ep.proxy_protocol && (
                  <div className="mt-1 text-xs text-content-muted">PROXY protocol from: {ep.proxy_protocol.trusted_ips.join(', ')}</div>
                )}
              </div>
              <div className="flex gap-2">
                <button onClick={() => setEditing(ep)} className="text-xs text-content-muted hover:text-content-primary">Edit</button>
                <button
                  onClick={() => {
                    if (confirm(`Delete entrypoint "${ep.name}"?`)) {
                      save(entrypoints.filter(e => e.name !== ep.name));
                    }
                  }}
                  className="text-xs text-red-400 hover:text-red-300"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {(editing || adding) && (
        <EntrypointModal
          initial={editing ?? undefined}
          onClose={() => { setEditing(null); setAdding(false); }}
          onSubmit={(ep) => {
            const idx = entrypoints.findIndex(e => e.name === ep.name);
            const next = idx >= 0
              ? entrypoints.map((e, i) => i === idx ? ep : e)
              : [...entrypoints, ep];
            save(next);
            setEditing(null);
            setAdding(false);
          }}
        />
      )}
    </div>
  );
}

function EntrypointModal({
  initial, onClose, onSubmit,
}: {
  initial?: Entrypoint;
  onClose: () => void;
  onSubmit: (ep: Entrypoint) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [port, setPort] = useState(String(initial?.port ?? 80));
  const [redirectTo, setRedirectTo] = useState(initial?.redirect_to ?? '');
  const [forwardedTrusted, setForwardedTrusted] = useState((initial?.forwarded_headers?.trusted_ips ?? []).join(', '));
  const [proxyTrusted, setProxyTrusted] = useState((initial?.proxy_protocol?.trusted_ips ?? []).join(', '));

  const submit = () => {
    if (!name.trim()) return toast.error('Name required');
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return toast.error('Port must be 1–65535');
    const fwIps = forwardedTrusted.split(',').map(s => s.trim()).filter(Boolean);
    const ppIps = proxyTrusted.split(',').map(s => s.trim()).filter(Boolean);
    const ep: Entrypoint = {
      name: name.trim(),
      port: portNum,
      redirect_to: redirectTo.trim() || undefined,
      forwarded_headers: fwIps.length > 0 ? { trusted_ips: fwIps } : undefined,
      proxy_protocol: ppIps.length > 0 ? { trusted_ips: ppIps } : undefined,
    };
    onSubmit(ep);
  };

  return (
    <Modal title={initial ? `Edit "${initial.name}"` : 'Add entrypoint'} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <Field label="Name">
          <input value={name} onChange={e => setName(e.target.value)} disabled={!!initial} className={inputCls} placeholder="web" />
        </Field>
        <Field label="Port">
          <input type="number" value={port} onChange={e => setPort(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Redirect to (optional)">
          <input value={redirectTo} onChange={e => setRedirectTo(e.target.value)} className={inputCls} placeholder="websecure" />
          <p className="mt-1 text-xs text-content-faint">Set on the HTTP entrypoint to redirect to HTTPS. Leave empty when sitting behind an upstream HTTPS terminator.</p>
        </Field>
        <Field label="Forwarded headers — trusted IPs">
          <input value={forwardedTrusted} onChange={e => setForwardedTrusted(e.target.value)} className={inputCls} placeholder="10.0.0.0/8, 172.16.0.0/12" />
          <p className="mt-1 text-xs text-content-faint">CIDRs of upstream proxies whose X-Forwarded-* headers Traefik should trust. Required when behind Cloudflare / ALB / nginx.</p>
        </Field>
        <Field label="PROXY protocol — trusted IPs">
          <input value={proxyTrusted} onChange={e => setProxyTrusted(e.target.value)} className={inputCls} placeholder="10.0.0.0/8" />
          <p className="mt-1 text-xs text-content-faint">CIDRs allowed to send PROXY protocol headers (HAProxy / AWS NLB).</p>
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="rounded-lg border border-border px-3 py-2 text-content-secondary hover:bg-surface-subtle">Cancel</button>
          <button onClick={submit} className="rounded-lg bg-brand-600 px-3 py-2 text-white hover:bg-brand-500">Save</button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Shared field helper ───────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-content-muted">{label}</span>
      {children}
    </label>
  );
}

const inputCls = 'w-full rounded-lg border border-border bg-surface-base px-3 py-2 text-sm text-content-primary focus:border-brand-500 focus:outline-none';
