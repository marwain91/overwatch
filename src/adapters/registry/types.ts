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
 * `githubApp` carries resolved GitHub App credentials when auth.type === 'github_app';
 * adapters mint installation tokens on demand instead of using a static `token`.
 */
export interface RegistryAdapterConfig {
  type: 'ghcr' | 'dockerhub' | 'ecr' | 'custom';
  url: string;
  repository: string;
  username?: string;
  token?: string;
  awsRegion?: string;
  githubApp?: {
    appId: string;
    privateKey: string;
    installationId: string;
  };
  tagPattern?: RegExp;
}

function resolveGitHubAppCreds(auth: {
  app_id_env?: string;
  installation_id_env?: string;
  private_key_env?: string;
}): RegistryAdapterConfig['githubApp'] {
  if (!auth.app_id_env || !auth.installation_id_env || !auth.private_key_env) return undefined;
  const appId = process.env[auth.app_id_env];
  const installationId = process.env[auth.installation_id_env];
  const privateKey = process.env[auth.private_key_env];
  if (!appId || !installationId || !privateKey) return undefined;
  return { appId, installationId, privateKey };
}

/**
 * Convert Overwatch config to adapter config
 */
export function toAdapterConfig(config: RegistryConfig): RegistryAdapterConfig {
  const auth = config.auth as RegistryConfig['auth'] & {
    app_id_env?: string;
    installation_id_env?: string;
    private_key_env?: string;
  };
  return {
    type: config.type,
    url: config.url,
    repository: config.repository,
    username: auth.username_env ? process.env[auth.username_env] : undefined,
    token: auth.token_env ? process.env[auth.token_env] : undefined,
    awsRegion: auth.aws_region_env ? process.env[auth.aws_region_env] : undefined,
    githubApp: auth.type === 'github_app' ? resolveGitHubAppCreds(auth) : undefined,
    tagPattern: config.tag_pattern ? new RegExp(config.tag_pattern) : undefined,
  };
}
