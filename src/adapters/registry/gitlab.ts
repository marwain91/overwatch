import { spawnSync } from 'child_process';
import { RegistryAdapter, RegistryAdapterConfig } from './types';
import { validateRegistryUrl } from './urlValidation';

interface GitLabTag {
  name: string;
}

/**
 * GitLab registry adapter (SaaS + self-hosted).
 *
 * `docker login` uses the literal username `oauth2` — works for every GitLab
 * token type that can pull images: PATs, Project/Group Access Tokens, and
 * Deploy Tokens. Tag listing hits the REST API at `/api/v4/projects/:id/repository/tags`
 * with a `PRIVATE-TOKEN` header. Deploy Tokens cannot list tags (they have no
 * `read_api` equivalent); use a Group Access Token for org repos.
 *
 * For self-hosted GitLab the registry host (`registry.acme.com:5050`) and
 * the REST-API host (`gitlab.acme.com`) often differ. `config.apiUrl` carries
 * the API base; when unset, the SaaS pair (`registry.gitlab.com` →
 * `https://gitlab.com`) is auto-derived. Any other unset case fails fast
 * with a descriptive error.
 *
 * Self-hosted API URLs are SSRF-checked by the shared `validateRegistryUrl`;
 * set `OVERWATCH_ALLOW_PRIVATE_REGISTRY_URL=1` to opt out when Overwatch and
 * GitLab share a private network on purpose.
 */
export class GitLabAdapter implements RegistryAdapter {
  private config: RegistryAdapterConfig;

  constructor(config: RegistryAdapterConfig) {
    this.config = config;
  }

  private apiBase(): string {
    if (this.config.apiUrl) return this.config.apiUrl.replace(/\/$/, '');
    if (this.config.url === 'registry.gitlab.com') return 'https://gitlab.com';
    throw new Error(
      `GitLab registry at '${this.config.url}' needs an api_url ` +
        `(e.g. https://gitlab.acme.com) — registry host and API host differ on self-hosted GitLab.`,
    );
  }

  async login(): Promise<void> {
    if (!this.config.token) {
      console.log('GitLab token not configured, skipping registry login');
      return;
    }

    try {
      console.log(`Authenticating with GitLab Container Registry at ${this.config.url}...`);
      const result = spawnSync(
        'docker',
        ['login', this.config.url, '-u', 'oauth2', '--password-stdin'],
        { input: this.config.token, stdio: ['pipe', 'pipe', 'pipe'] },
      );

      if (result.status !== 0) {
        throw new Error(result.stderr?.toString() || 'docker login failed');
      }

      console.log(`Successfully logged in to ${this.config.url}`);
    } catch (error) {
      console.error('Failed to login to GitLab registry:', error);
      throw error;
    }
  }

  async getImageTags(): Promise<string[]> {
    if (!this.config.token) {
      throw new Error('GitLab token not configured');
    }

    const apiBase = this.apiBase();
    if (this.config.apiUrl) {
      // SaaS-derived gitlab.com is trusted; only validate operator-supplied hosts.
      await validateRegistryUrl(apiBase);
    }

    const projectId = encodeURIComponent(this.config.repository);
    const url = `${apiBase}/api/v4/projects/${projectId}/repository/tags?per_page=100&order_by=name&sort=desc`;
    const response = await fetch(url, {
      headers: {
        'PRIVATE-TOKEN': this.config.token,
        Accept: 'application/json',
      },
    });

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `GitLab API denied access (HTTP ${response.status}). The token needs the 'read_api' scope ` +
          `to list tags for ${this.config.repository}. Deploy Tokens cannot list tags — use a ` +
          `Personal, Project, or Group Access Token (Group recommended for org repos).`,
      );
    }
    if (response.status === 404) {
      throw new Error(
        `GitLab project '${this.config.repository}' not found at ${apiBase}, or the token cannot see it. ` +
          `Verify the repository path matches the GitLab project's full path (e.g. 'group/subgroup/project').`,
      );
    }
    if (!response.ok) {
      throw new Error(`GitLab tags API failed (HTTP ${response.status}).`);
    }

    const tags = (await response.json()) as GitLabTag[];
    const pattern = this.config.tagPattern;

    return tags
      .map((t) => t.name)
      .filter((name) => (pattern ? pattern.test(name) : true))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  }

  getImageRef(service: string, tag: string): string {
    return `${this.config.url}/${this.config.repository}/${service}:${tag}`;
  }

  getType(): string {
    return 'gitlab';
  }
}
