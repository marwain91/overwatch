import type { AppRegistry } from '../lib/types';

interface RegistryFormProps {
  value: AppRegistry;
  onChange: (next: AppRegistry) => void;
  // Wizard only: switching to GitLab/GHCR pre-fills the registry URL. Off when editing an
  // existing app so a type change never silently rewrites a URL the operator set.
  smartDefaults?: boolean;
}

export function RegistryForm({ value: registry, onChange, smartDefaults = false }: RegistryFormProps) {
  const setAuth = (patch: Partial<AppRegistry['auth']>) => onChange({ ...registry, auth: { ...registry.auth, ...patch } });

  const handleTypeChange = (next: AppRegistry['type']) => {
    if (smartDefaults && next === 'gitlab' && registry.type !== 'gitlab') {
      onChange({ ...registry, type: next, url: 'registry.gitlab.com', auth: { ...registry.auth, type: 'token' } });
    } else if (smartDefaults && next === 'ghcr' && registry.type !== 'ghcr') {
      onChange({ ...registry, type: next, url: 'ghcr.io' });
    } else {
      onChange({ ...registry, type: next });
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="label">Registry Type</label>
        <select className="input" value={registry.type} onChange={(e) => handleTypeChange(e.target.value as AppRegistry['type'])}>
          <option value="ghcr">GitHub Container Registry</option>
          <option value="gitlab">GitLab Container Registry</option>
          <option value="dockerhub">Docker Hub</option>
          <option value="ecr">AWS ECR</option>
          <option value="custom">Custom</option>
        </select>
      </div>
      <div>
        <label className="label">Registry URL</label>
        <input className="input" value={registry.url} onChange={(e) => onChange({ ...registry, url: e.target.value })} placeholder="ghcr.io" />
      </div>
      {registry.type === 'gitlab' && (
        <div>
          <label className="label">
            API URL <span className="text-content-faint">(optional for gitlab.com SaaS)</span>
          </label>
          <input
            className="input"
            value={registry.api_url || ''}
            onChange={(e) => onChange({ ...registry, api_url: e.target.value || undefined })}
            placeholder="https://gitlab.acme.com"
          />
          <p className="mt-1 text-xs text-content-faint">
            Required for self-hosted GitLab — registry host and API host commonly differ. Leave empty when using <code>gitlab.com</code>. See{' '}
            <a
              href="https://github.com/marwain91/overwatch/blob/main/docs/registry-gitlab.md"
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-content-muted"
            >
              registry-gitlab.md
            </a>.
          </p>
        </div>
      )}
      <div>
        <label className="label">Repository</label>
        <input className="input" value={registry.repository} onChange={(e) => onChange({ ...registry, repository: e.target.value })} placeholder="org/repo" />
      </div>
      <div>
        <label className="label">Auth Type</label>
        <select className="input" value={registry.auth.type} onChange={(e) => setAuth({ type: e.target.value as AppRegistry['auth']['type'] })}>
          <option value="token">Personal Access Token</option>
          <option value="basic">Basic (username/password)</option>
          <option value="aws_iam">AWS ECR</option>
        </select>
      </div>
      {(registry.auth.type === 'token' || registry.auth.type === 'basic') && (
        <>
          <div>
            <label className="label">Username Env Var</label>
            <input className="input" value={registry.auth.username_env || ''} onChange={(e) => setAuth({ username_env: e.target.value })} placeholder="GHCR_USERNAME" />
          </div>
          <div>
            <label className="label">Token Env Var</label>
            <input className="input" value={registry.auth.token_env || ''} onChange={(e) => setAuth({ token_env: e.target.value })} placeholder="GHCR_TOKEN" />
          </div>
        </>
      )}
      {registry.auth.type === 'aws_iam' && (
        <div>
          <label className="label">AWS Region Env Var</label>
          <input className="input" value={registry.auth.aws_region_env || ''} onChange={(e) => setAuth({ aws_region_env: e.target.value })} placeholder="AWS_REGION" />
        </div>
      )}
      <div>
        <label className="label">Tag Pattern (optional)</label>
        <input
          className="input"
          value={registry.tag_pattern || ''}
          onChange={(e) => onChange({ ...registry, tag_pattern: e.target.value || undefined })}
          placeholder="^v\d+\.\d+\.\d+$"
        />
        <p className="mt-1 text-xs text-content-faint">Regular expression a registry tag must match to be offered as an image version.</p>
      </div>
    </div>
  );
}
