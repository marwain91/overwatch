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
