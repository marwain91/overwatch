import { RegistryConfig } from '../../config';

/**
 * Interface for container registry adapters.
 * Each adapter handles authentication and tag fetching for a specific registry.
 */
export interface RegistryAdapter {
  /**
   * Authenticate with the registry (docker login)
   */
  login(): Promise<void>;

  /**
   * Get available image tags from the registry
   */
  getImageTags(): Promise<string[]>;

  /**
   * Get the full image reference for a service and tag
   */
  getImageRef(service: string, tag: string): string;

  /**
   * Get the registry type
   */
  getType(): string;
}

/**
 * Configuration passed to registry adapters
 */
export interface RegistryAdapterConfig {
  type: 'ghcr' | 'dockerhub' | 'ecr' | 'custom';
  url: string;
  repository: string;
  username?: string;
  token?: string;
  awsRegion?: string;
  tagPattern?: RegExp;
}

/**
 * Convert Overwatch config to adapter config
 */
export function toAdapterConfig(config: RegistryConfig): RegistryAdapterConfig {
  return {
    type: config.type,
    url: config.url,
    repository: config.repository,
    username: config.auth.username_env ? process.env[config.auth.username_env] : undefined,
    token: config.auth.token_env ? process.env[config.auth.token_env] : undefined,
    awsRegion: config.auth.aws_region_env ? process.env[config.auth.aws_region_env] : undefined,
    tagPattern: config.tag_pattern ? new RegExp(config.tag_pattern) : undefined,
  };
}
