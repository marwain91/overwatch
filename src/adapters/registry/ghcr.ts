import { execSync } from 'child_process';
import { RegistryAdapter, RegistryAdapterConfig } from './types';

/**
 * GitHub Container Registry adapter
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

      execSync(
        `echo "${this.config.token}" | docker login ${this.config.url} -u ${username} --password-stdin`,
        { stdio: 'pipe' }
      );

      console.log(`Successfully logged in to ${this.config.url}`);
    } catch (error) {
      console.error('Failed to login to GHCR:', error);
      throw error;
    }
  }

  async getImageTags(): Promise<string[]> {
    if (!this.config.token) {
      console.warn('GHCR token not configured, cannot fetch tags');
      return [];
    }

    try {
      const response = await fetch(
        `https://api.github.com/repos/${this.config.repository}/tags?per_page=100`,
        {
          headers: {
            'Authorization': `Bearer ${this.config.token}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error('GitHub API error:', response.status, errorText);
        return [];
      }

      const gitTags = await response.json() as Array<{ name: string }>;

      // Filter for version tags (starting with 'v') and sort descending
      return gitTags
        .map(t => t.name)
        .filter(name => name.startsWith('v'))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    } catch (error) {
      console.error('Failed to fetch tags from GitHub:', error);
      return [];
    }
  }

  getImageRef(service: string, tag: string): string {
    return `${this.config.url}/${this.config.repository}/${service}:${tag}`;
  }

  getType(): string {
    return 'ghcr';
  }
}
