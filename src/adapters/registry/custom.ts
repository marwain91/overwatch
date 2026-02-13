import { execSync } from 'child_process';
import { RegistryAdapter, RegistryAdapterConfig } from './types';

/**
 * Custom/self-hosted registry adapter
 * Works with any Docker V2 compatible registry
 */
export class CustomRegistryAdapter implements RegistryAdapter {
  private config: RegistryAdapterConfig;

  constructor(config: RegistryAdapterConfig) {
    this.config = config;
  }

  async login(): Promise<void> {
    if (!this.config.username || !this.config.token) {
      console.log('Custom registry credentials not configured, skipping login');
      return;
    }

    try {
      console.log(`Authenticating with custom registry ${this.config.url}...`);

      execSync(
        `echo "${this.config.token}" | docker login ${this.config.url} -u ${this.config.username} --password-stdin`,
        { stdio: 'pipe' }
      );

      console.log(`Successfully logged in to ${this.config.url}`);
    } catch (error) {
      console.error('Failed to login to custom registry:', error);
      throw error;
    }
  }

  async getImageTags(): Promise<string[]> {
    // For custom registries, we try the Docker Registry V2 API
    // This may not work for all registries
    try {
      const repoUrl = `https://${this.config.url}/v2/${this.config.repository}/tags/list`;
      const headers: Record<string, string> = {};

      if (this.config.username && this.config.token) {
        const auth = Buffer.from(`${this.config.username}:${this.config.token}`).toString('base64');
        headers['Authorization'] = `Basic ${auth}`;
      }

      const response = await fetch(repoUrl, { headers });

      if (!response.ok) {
        console.error('Custom registry API error:', response.status);
        return [];
      }

      const data = await response.json() as { tags: string[] };

      const pattern = this.config.tagPattern || /^v/;
      return (data.tags || [])
        .filter(name => pattern.test(name))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    } catch (error) {
      console.error('Failed to fetch tags from custom registry:', error);
      return [];
    }
  }

  getImageRef(service: string, tag: string): string {
    return `${this.config.url}/${this.config.repository}/${service}:${tag}`;
  }

  getType(): string {
    return 'custom';
  }
}
