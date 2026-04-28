import { spawnSync } from 'child_process';
import { RegistryAdapter, RegistryAdapterConfig } from './types';

interface GitHubTag {
  name: string;
}

/**
 * GitHub Container Registry adapter.
 *
 * Container pulls use GHCR (requires `read:packages`). Tag listing reads
 * GitHub git tags (requires `repo` scope for private source repos) so the
 * UI surfaces coordinated cross-service release tags rather than per-image
 * registry tags (which diverge across backend/frontend/migrator images).
 *
 * Auth: PAT only. `config.token` is the bearer for both docker login and the
 * tags API. GitHub App auth was attempted in v1.6.x but removed in v1.6.7
 * because GHCR's permission model doesn't honor App tokens for non-public
 * packages — see the rationale in models/app.ts. For service-to-service
 * pulls of private/internal packages, use a fine-grained PAT under a
 * dedicated service-account user.
 */
export class GHCRAdapter implements RegistryAdapter {
  private config: RegistryAdapterConfig;

  constructor(config: RegistryAdapterConfig) {
    this.config = config;
  }

  async login(): Promise<void> {
    const token = this.config.token;

    if (!token) {
      console.log('GHCR auth not configured, skipping registry login');
      return;
    }

    try {
      console.log('Authenticating with GitHub Container Registry...');
      const username = this.config.username || 'x-access-token';

      const result = spawnSync(
        'docker', ['login', this.config.url, '-u', username, '--password-stdin'],
        { input: token, stdio: ['pipe', 'pipe', 'pipe'] }
      );

      if (result.status !== 0) {
        throw new Error(result.stderr?.toString() || 'docker login failed');
      }

      console.log(`Successfully logged in to ${this.config.url}`);
    } catch (error) {
      console.error('Failed to login to GHCR:', error);
      throw error;
    }
  }

  async getImageTags(): Promise<string[]> {
    const token = this.config.token;
    if (!token) {
      throw new Error('GHCR auth not configured');
    }

    const url = `https://api.github.com/repos/${this.config.repository}/tags?per_page=100`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `GitHub API denied access (HTTP ${response.status}). ` +
        `GHCR_TOKEN (or the configured token_env) needs the 'repo' scope to list tags for ${this.config.repository}.`,
      );
    }
    if (response.status === 404) {
      throw new Error(
        `GitHub repository ${this.config.repository} not found or not accessible to the configured credentials.`,
      );
    }
    if (!response.ok) {
      throw new Error(`GitHub tags API failed (HTTP ${response.status}).`);
    }

    const gitTags = (await response.json()) as GitHubTag[];
    const pattern = this.config.tagPattern;

    return gitTags
      .map((t) => t.name)
      .filter((name) => (pattern ? pattern.test(name) : true))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  }

  getImageRef(service: string, tag: string): string {
    return `${this.config.url}/${this.config.repository}/${service}:${tag}`;
  }

  getType(): string {
    return 'ghcr';
  }
}
