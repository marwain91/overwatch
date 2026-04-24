import { spawnSync } from 'child_process';
import { RegistryAdapter, RegistryAdapterConfig } from './types';

interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
}

/**
 * GitHub Container Registry adapter.
 *
 * Container pulls use GHCR (requires `read:packages`). Tag listing reads
 * GitHub Releases (requires `repo` scope for private source repos) so the
 * UI surfaces coordinated cross-service release tags rather than per-image
 * registry tags (which diverge across backend/frontend/migrator images).
 */
export class GHCRAdapter implements RegistryAdapter {
  private config: RegistryAdapterConfig;

  constructor(config: RegistryAdapterConfig) {
    this.config = config;
  }

  async login(): Promise<void> {
    if (!this.config.token) {
      console.log('GHCR token not configured, skipping registry login');
      return;
    }

    try {
      console.log('Authenticating with GitHub Container Registry...');
      const username = this.config.username || 'x-access-token';

      const result = spawnSync(
        'docker', ['login', this.config.url, '-u', username, '--password-stdin'],
        { input: this.config.token, stdio: ['pipe', 'pipe', 'pipe'] }
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
    if (!this.config.token) {
      throw new Error('GHCR token not configured');
    }

    const url = `https://api.github.com/repos/${this.config.repository}/releases?per_page=100`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `GitHub API denied access (HTTP ${response.status}). GHCR_TOKEN needs the 'repo' scope to list releases for ${this.config.repository}.`,
      );
    }
    if (response.status === 404) {
      throw new Error(
        `GitHub repository ${this.config.repository} not found or not accessible to the configured token.`,
      );
    }
    if (!response.ok) {
      throw new Error(`GitHub releases API failed (HTTP ${response.status}).`);
    }

    const releases = (await response.json()) as GitHubRelease[];
    const pattern = this.config.tagPattern;

    return releases
      .filter((r) => !r.draft)
      .map((r) => r.tag_name)
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
