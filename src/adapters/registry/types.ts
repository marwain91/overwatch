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
 * Configuration passed to registry adapters.
 * `apiUrl` is the REST-API base for registries where it differs from the
 * registry host — currently only GitLab self-hosted.
 */
export interface RegistryAdapterConfig {
  type: 'ghcr' | 'dockerhub' | 'ecr' | 'custom' | 'gitlab';
  url: string;
  apiUrl?: string;
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
  const auth = config.auth;
  return {
    type: config.type,
    url: config.url,
    apiUrl: config.api_url,
    repository: config.repository,
    username: auth.username_env ? process.env[auth.username_env] : undefined,
    token: auth.token_env ? process.env[auth.token_env] : undefined,
    awsRegion: auth.aws_region_env ? process.env[auth.aws_region_env] : undefined,
    tagPattern: config.tag_pattern ? new RegExp(config.tag_pattern) : undefined,
  };
}
