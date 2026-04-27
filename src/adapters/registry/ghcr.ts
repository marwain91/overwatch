import { spawnSync } from 'child_process';
import { RegistryAdapter, RegistryAdapterConfig } from './types';
import { getInstallationToken } from '../../services/githubApp';

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
 * Two auth paths:
 * - PAT: `config.token` is the bearer for both docker login and the tags API.
 * - GitHub App: `config.githubApp` mints short-lived installation tokens via
 *   `getInstallationToken()`. The same minted token is used for both surfaces;
 *   permissions needed: Contents:Read (tags) + Packages:Read (GHCR pull).
 */
export class GHCRAdapter implements RegistryAdapter {
  private config: RegistryAdapterConfig;

  constructor(config: RegistryAdapterConfig) {
    this.config = config;
  }

  private isGitHubApp(): boolean {
    return !!this.config.githubApp;
  }

  private async resolveToken(): Promise<string | undefined> {
    if (this.config.githubApp) {
      return getInstallationToken(this.config.githubApp);
    }
    return this.config.token;
  }

  async login(): Promise<void> {
    let token: string | undefined;
    try {
      token = await this.resolveToken();
    } catch (error) {
      console.error('Failed to mint GitHub App installation token:', error);
      throw error;
    }

    if (!token) {
      console.log('GHCR auth not configured, skipping registry login');
      return;
    }

    try {
      console.log('Authenticating with GitHub Container Registry...');
      // GitHub App installation tokens require the literal username 'x-access-token'.
      const username = this.isGitHubApp() ? 'x-access-token' : (this.config.username || 'x-access-token');

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
    const token = await this.resolveToken();
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
      const hint = this.isGitHubApp()
        ? `the configured GitHub App needs Contents:Read permission and must be installed on ${this.config.repository}`
        : `GHCR_TOKEN needs the 'repo' scope to list tags for ${this.config.repository}`;
      throw new Error(`GitHub API denied access (HTTP ${response.status}). ${hint}.`);
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
