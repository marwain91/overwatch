import { execFileSync, spawnSync } from 'child_process';
import { RegistryAdapter, RegistryAdapterConfig } from './types';

/**
 * AWS Elastic Container Registry adapter
 */
export class ECRAdapter implements RegistryAdapter {
  private config: RegistryAdapterConfig;

  constructor(config: RegistryAdapterConfig) {
    this.config = config;
  }

  async login(): Promise<void> {
    const region = this.config.awsRegion || 'us-east-1';

    try {
      console.log(`Authenticating with AWS ECR in ${region}...`);

      // Get login password from AWS CLI (no shell)
      const password = execFileSync(
        'aws', ['ecr', 'get-login-password', '--region', region],
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();

      // Pipe password to docker login via stdin (no shell)
      const result = spawnSync(
        'docker', ['login', '--username', 'AWS', '--password-stdin', this.config.url],
        { input: password, stdio: ['pipe', 'pipe', 'pipe'] }
      );

      if (result.status !== 0) {
        throw new Error(result.stderr?.toString() || 'docker login failed');
      }

      console.log(`Successfully logged in to ${this.config.url}`);
    } catch (error) {
      console.error('Failed to login to ECR:', error);
      throw error;
    }
  }

  async getImageTags(): Promise<string[]> {
    const region = this.config.awsRegion || 'us-east-1';

    try {
      // Use AWS CLI to list image tags (no shell)
      const result = execFileSync(
        'aws', ['ecr', 'describe-images', '--repository-name', this.config.repository, '--region', region, '--query', 'imageDetails[*].imageTags', '--output', 'json'],
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );

      const tags = JSON.parse(result)
        .flat()
        .filter((t: string | null) => t !== null);

      const pattern = this.config.tagPattern || /^v/;
      return tags
        .filter((name: string) => pattern.test(name))
        .sort((a: string, b: string) => b.localeCompare(a, undefined, { numeric: true }));
    } catch (error) {
      console.error('Failed to fetch tags from ECR:', error);
      return [];
    }
  }

  getImageRef(service: string, tag: string): string {
    return `${this.config.url}/${this.config.repository}/${service}:${tag}`;
  }

  getType(): string {
    return 'ecr';
  }
}
