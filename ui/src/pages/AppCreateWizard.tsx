import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useCreateApp } from '../hooks/useApps';
import type { AppService, AppRegistry, AppBackup, AppAdminAccess } from '../lib/types';

type Step = 'basics' | 'registry' | 'services' | 'backup' | 'review';
const steps: Step[] = ['basics', 'registry', 'services', 'backup', 'review'];
const stepLabels: Record<Step, string> = {
  basics: 'Basics',
  registry: 'Registry',
  services: 'Services',
  backup: 'Backup',
  review: 'Review',
};

export function AppCreateWizard() {
  const navigate = useNavigate();
  const createApp = useCreateApp();
  const [step, setStep] = useState<Step>('basics');

  // Form state
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [domainTemplate, setDomainTemplate] = useState('');
  const [defaultImageTag, setDefaultImageTag] = useState('latest');

  const [registry, setRegistry] = useState<AppRegistry>({
    type: 'ghcr',
    url: 'ghcr.io',
    repository: '',
    auth: { type: 'token', token_env: 'GHCR_TOKEN', username_env: 'GHCR_USERNAME' },
  });

  const [services, setServices] = useState<AppService[]>([
    {
      name: 'backend',
      required: true,
      is_init_container: false,
      ports: { internal: 3000 },
      health_check: { type: 'http', path: '/health', port: 3000, interval: 30 },
    },
  ]);

  const [backup, setBackup] = useState<AppBackup>({
    enabled: false,
    provider: 's3',
    schedule: '0 2 * * *',
  });

  const [adminAccess, setAdminAccess] = useState<AppAdminAccess>({
    enabled: false,
  });

  const updateS3 = (field: string, value: string) =>
    setBackup({ ...backup, s3: { ...backup.s3!, [field]: value } });

  const stepIdx = steps.indexOf(step);
  const canNext = stepIdx < steps.length - 1;
  const canPrev = stepIdx > 0;

  const goNext = () => canNext && setStep(steps[stepIdx + 1]);
  const goPrev = () => canPrev && setStep(steps[stepIdx - 1]);

  const handleSubmit = async () => {
    try {
      await createApp.mutateAsync({
        id,
        name,
        domain_template: domainTemplate,
        default_image_tag: defaultImageTag,
        registry,
        services,
        backup: backup.enabled ? backup : undefined,
        admin_access: adminAccess.enabled ? adminAccess : undefined,
      });
      toast.success(`App "${name}" created`);
      navigate(`/apps/${id}/tenants`);
    } catch (err: unknown) {
      toast.error((err as Error).message);
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-6 text-2xl font-bold text-content-primary">Create App</h1>

      {/* Step indicator */}
      <div className="mb-8 flex gap-1">
        {steps.map((s, i) => (
          <button
            key={s}
            onClick={() => setStep(s)}
            className={`flex-1 rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
              s === step
                ? 'bg-brand-600 text-white'
                : i < stepIdx
                  ? 'bg-surface-subtle text-brand-400'
                  : 'bg-surface-raised text-content-faint'
            }`}
          >
            {stepLabels[s]}
          </button>
        ))}
      </div>

      {/* Step content */}
      <div className="card">
        {step === 'basics' && (
          <div className="space-y-4">
            <div>
              <label className="label">App ID</label>
              <input
                className="input"
                value={id}
                onChange={(e) => setId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                placeholder="my-app"
              />
              <p className="mt-1 text-xs text-content-faint">Lowercase letters, numbers, hyphens</p>
            </div>
            <div>
              <label className="label">Display Name</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="My Application" />
            </div>
            <div>
              <label className="label">Domain Template</label>
              <input className="input" value={domainTemplate} onChange={(e) => setDomainTemplate(e.target.value)} placeholder="*.myapp.com" />
              <p className="mt-1 text-xs text-content-faint">Use * as wildcard for tenant subdomain</p>
            </div>
            <div>
              <label className="label">Default Image Tag</label>
              <input className="input" value={defaultImageTag} onChange={(e) => setDefaultImageTag(e.target.value)} placeholder="latest" />
            </div>
          </div>
        )}

        {step === 'registry' && (
          <div className="space-y-4">
            <div>
              <label className="label">Registry Type</label>
              <select
                className="input"
                value={registry.type}
                onChange={(e) => setRegistry({ ...registry, type: e.target.value as AppRegistry['type'] })}
              >
                <option value="ghcr">GitHub Container Registry</option>
                <option value="dockerhub">Docker Hub</option>
                <option value="ecr">AWS ECR</option>
                <option value="custom">Custom</option>
              </select>
            </div>
            <div>
              <label className="label">Registry URL</label>
              <input className="input" value={registry.url} onChange={(e) => setRegistry({ ...registry, url: e.target.value })} placeholder="ghcr.io" />
            </div>
            <div>
              <label className="label">Repository</label>
              <input className="input" value={registry.repository} onChange={(e) => setRegistry({ ...registry, repository: e.target.value })} placeholder="org/repo" />
            </div>
            <div>
              <label className="label">Auth Type</label>
              <select
                className="input"
                value={registry.auth.type}
                onChange={(e) => setRegistry({ ...registry, auth: { ...registry.auth, type: e.target.value as 'token' | 'aws_ecr' | 'basic' } })}
              >
                <option value="token">Token</option>
                <option value="basic">Basic (username/password)</option>
                <option value="aws_ecr">AWS ECR</option>
              </select>
            </div>
            {(registry.auth.type === 'token' || registry.auth.type === 'basic') && (
              <>
                <div>
                  <label className="label">Username Env Var</label>
                  <input
                    className="input"
                    value={registry.auth.username_env || ''}
                    onChange={(e) => setRegistry({ ...registry, auth: { ...registry.auth, username_env: e.target.value } })}
                    placeholder="GHCR_USERNAME"
                  />
                </div>
                <div>
                  <label className="label">Token Env Var</label>
                  <input
                    className="input"
                    value={registry.auth.token_env || ''}
                    onChange={(e) => setRegistry({ ...registry, auth: { ...registry.auth, token_env: e.target.value } })}
                    placeholder="GHCR_TOKEN"
                  />
                </div>
              </>
            )}
            {registry.auth.type === 'aws_ecr' && (
              <div>
                <label className="label">AWS Region Env Var</label>
                <input
                  className="input"
                  value={registry.auth.aws_region_env || ''}
                  onChange={(e) => setRegistry({ ...registry, auth: { ...registry.auth, aws_region_env: e.target.value } })}
                  placeholder="AWS_REGION"
                />
              </div>
            )}
            <div>
              <label className="label">Tag Pattern (optional)</label>
              <input
                className="input"
                value={registry.tag_pattern || ''}
                onChange={(e) => setRegistry({ ...registry, tag_pattern: e.target.value || undefined })}
                placeholder="^v\\d+\\.\\d+\\.\\d+$"
              />
            </div>
          </div>
        )}

        {step === 'services' && (
          <div className="space-y-4">
            <p className="text-sm text-content-muted">
              Define the Docker services for this application.
            </p>
            {services.map((svc, i) => (
              <ServiceEditor
                key={i}
                service={svc}
                onChange={(updated) => {
                  const next = [...services];
                  next[i] = updated;
                  setServices(next);
                }}
                onRemove={() => setServices(services.filter((_, j) => j !== i))}
              />
            ))}
            <button
              className="btn btn-secondary"
              onClick={() =>
                setServices([
                  ...services,
                  {
                    name: '',
                    required: false,
                    is_init_container: false,
                  },
                ])
              }
            >
              + Add Service
            </button>
          </div>
        )}

        {step === 'backup' && (
          <div className="space-y-4">
            <label className="flex items-center gap-2 text-sm text-content-tertiary">
              <input
                type="checkbox"
                checked={backup.enabled}
                onChange={(e) => setBackup({ ...backup, enabled: e.target.checked })}
                className="rounded border-border-subtle"
              />
              Enable backups
            </label>
            {backup.enabled && (
              <>
                <div>
                  <label className="label">Provider</label>
                  <select
                    className="input"
                    value={backup.provider}
                    onChange={(e) => setBackup({ ...backup, provider: e.target.value as AppBackup['provider'] })}
                  >
                    <option value="s3">S3 / R2 / MinIO</option>
                    <option value="local">Local</option>
                  </select>
                </div>
                <div>
                  <label className="label">Schedule (cron)</label>
                  <input
                    className="input"
                    value={backup.schedule || ''}
                    onChange={(e) => setBackup({ ...backup, schedule: e.target.value })}
                    placeholder="0 2 * * *"
                  />
                </div>
                {backup.provider === 's3' && (
                  <>
                    <div>
                      <label className="label">S3 Endpoint Env</label>
                      <input className="input" value={backup.s3?.endpoint_env || ''} onChange={(e) => updateS3('endpoint_env', e.target.value)} placeholder="S3_ENDPOINT" />
                    </div>
                    <div>
                      <label className="label">S3 Bucket Env</label>
                      <input className="input" value={backup.s3?.bucket_env || ''} onChange={(e) => updateS3('bucket_env', e.target.value)} placeholder="S3_BUCKET" />
                    </div>
                    <div>
                      <label className="label">S3 Access Key Env</label>
                      <input className="input" value={backup.s3?.access_key_env || ''} onChange={(e) => updateS3('access_key_env', e.target.value)} placeholder="S3_ACCESS_KEY" />
                    </div>
                    <div>
                      <label className="label">S3 Secret Key Env</label>
                      <input className="input" value={backup.s3?.secret_key_env || ''} onChange={(e) => updateS3('secret_key_env', e.target.value)} placeholder="S3_SECRET_KEY" />
                    </div>
                  </>
                )}
                <div>
                  <label className="label">Restic Password Env</label>
                  <input
                    className="input"
                    value={backup.restic_password_env || ''}
                    onChange={(e) => setBackup({ ...backup, restic_password_env: e.target.value })}
                    placeholder="RESTIC_PASSWORD"
                  />
                </div>
              </>
            )}

            <div className="mt-6 border-t border-border pt-4">
              <label className="flex items-center gap-2 text-sm text-content-tertiary">
                <input
                  type="checkbox"
                  checked={adminAccess.enabled}
                  onChange={(e) => setAdminAccess({ ...adminAccess, enabled: e.target.checked })}
                  className="rounded border-border-subtle"
                />
                Enable admin access tokens
              </label>
              {adminAccess.enabled && (
                <>
                  <div className="mt-3">
                    <label className="label">URL Template</label>
                    <input
                      className="input"
                      value={adminAccess.url_template || ''}
                      onChange={(e) => setAdminAccess({ ...adminAccess, url_template: e.target.value })}
                      placeholder="https://{domain}/admin/auto-login?token={token}"
                    />
                  </div>
                  <div className="mt-3">
                    <label className="label">Secret Env Var</label>
                    <input
                      className="input"
                      value={adminAccess.secret_env || ''}
                      onChange={(e) => setAdminAccess({ ...adminAccess, secret_env: e.target.value })}
                      placeholder="ADMIN_JWT_SECRET"
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {step === 'review' && (
          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-content-primary">Review</h3>
            <dl className="space-y-2 text-sm">
              <ReviewItem label="App ID" value={id} />
              <ReviewItem label="Name" value={name} />
              <ReviewItem label="Domain Template" value={domainTemplate} />
              <ReviewItem label="Default Tag" value={defaultImageTag} />
              <ReviewItem label="Registry" value={`${registry.type} — ${registry.url}/${registry.repository}`} />
              <ReviewItem label="Services" value={services.map((s) => s.name).join(', ')} />
              <ReviewItem label="Backup" value={backup.enabled ? `${backup.provider} — ${backup.schedule}` : 'Disabled'} />
              <ReviewItem label="Admin Access" value={adminAccess.enabled ? 'Enabled' : 'Disabled'} />
            </dl>
          </div>
        )}

        {/* Navigation */}
        <div className="mt-6 flex justify-between border-t border-border pt-4">
          <button className="btn btn-secondary" onClick={canPrev ? goPrev : () => navigate('/')}>
            {canPrev ? 'Back' : 'Cancel'}
          </button>
          {step === 'review' ? (
            <button className="btn btn-primary" onClick={handleSubmit} disabled={createApp.isPending}>
              {createApp.isPending ? <><span className="spinner spinner-sm" /> Creating...</> : 'Create App'}
            </button>
          ) : (
            <button className="btn btn-primary" onClick={goNext}>
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ReviewItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-content-faint">{label}</dt>
      <dd className="text-content-secondary">{value || '—'}</dd>
    </div>
  );
}

function ServiceEditor({
  service,
  onChange,
  onRemove,
}: {
  service: AppService;
  onChange: (s: AppService) => void;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(!!service.image_suffix);

  return (
    <div className="rounded-lg border border-border-subtle bg-surface-muted p-4">
      <div className="mb-3 flex items-center justify-between">
        <button onClick={() => setExpanded(!expanded)} className="text-sm font-medium text-content-secondary">
          {service.name || 'New Service'} {expanded ? '▾' : '▸'}
        </button>
        <button onClick={onRemove} className="text-xs text-red-400 hover:text-red-300">
          Remove
        </button>
      </div>

      {expanded && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Name</label>
            <input className="input" value={service.name} onChange={(e) => onChange({ ...service, name: e.target.value })} placeholder="backend" />
            <p className="mt-1 text-xs text-content-faint">Also used as the image name in the registry</p>
          </div>
          <div>
            <label className="label">Internal Port</label>
            <input className="input" type="number" value={service.ports?.internal || ''} onChange={(e) => onChange({ ...service, ports: { internal: parseInt(e.target.value) || 0 } })} placeholder="3000" />
          </div>
          <div className="col-span-2">
            <label className="label">Command (optional)</label>
            <input className="input" value={service.command?.join(' ') || ''} onChange={(e) => onChange({ ...service, command: e.target.value ? e.target.value.split(' ') : undefined })} placeholder="node server.js" />
          </div>
          <div className="col-span-2 flex gap-4">
            <label className="flex items-center gap-2 text-sm text-content-tertiary">
              <input type="checkbox" checked={service.required} onChange={(e) => onChange({ ...service, required: e.target.checked })} />
              Required
            </label>
            <label className="flex items-center gap-2 text-sm text-content-tertiary">
              <input type="checkbox" checked={service.is_init_container} onChange={(e) => onChange({ ...service, is_init_container: e.target.checked })} />
              Init Container
            </label>
          </div>
          {showAdvanced ? (
            <div className="col-span-2">
              <label className="label">Image Name Override</label>
              <input className="input" value={service.image_suffix || ''} onChange={(e) => onChange({ ...service, image_suffix: e.target.value || undefined })} placeholder={service.name || 'defaults to service name'} />
              <p className="mt-1 text-xs text-content-faint">Only set if the image name differs from the service name</p>
            </div>
          ) : (
            <button className="col-span-2 text-left text-xs text-content-faint hover:text-content-muted" onClick={() => setShowAdvanced(true)}>
              Advanced options...
            </button>
          )}
        </div>
      )}
    </div>
  );
}
