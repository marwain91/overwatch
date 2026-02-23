import { spawnSync } from 'child_process';
import { RegistryAdapter, RegistryAdapterConfig } from './types';

/**
 * Docker Hub registry adapter
 */
export class DockerHubAdapter implements RegistryAdapter {
  private config: RegistryAdapterConfig;

  constructor(config: RegistryAdapterConfig) {
    this.config = config;
  }

  async login(): Promise<void> {
    if (!this.config.username || !this.config.token) {
      console.log('Docker Hub credentials not configured, skipping registry login');
      return;
    }

    try {
      console.log('Authenticating with Docker Hub...');

      const result = spawnSync(
        'docker', ['login', '-u', this.config.username, '--password-stdin'],
        { input: this.config.token, stdio: ['pipe', 'pipe', 'pipe'] }
      );

      if (result.status !== 0) {
        throw new Error(result.stderr?.toString() || 'docker login failed');
      }

      console.log('Successfully logged in to Docker Hub');
    } catch (error) {
      console.error('Failed to login to Docker Hub:', error);
      throw error;
    }
  }

  async getImageTags(): Promise<string[]> {
    try {
      const response = await fetch(
        `https://hub.docker.com/v2/repositories/${this.config.repository}/tags?page_size=100`
      );

      if (!response.ok) {
        console.error('Docker Hub API error:', response.status);
        return [];
      }

      const data = await response.json() as { results: Array<{ name: string }> };

      const pattern = this.config.tagPattern || /^v/;
      return data.results
        .map(t => t.name)
        .filter(name => pattern.test(name))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    } catch (error) {
      console.error('Failed to fetch tags from Docker Hub:', error);
      return [];
    }
  }

  getImageRef(service: string, tag: string): string {
    // Docker Hub format: repository/service:tag (no URL prefix for docker.io)
    return `${this.config.repository}/${service}:${tag}`;
  }

  getType(): string {
    return 'dockerhub';
  }
}
