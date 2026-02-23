import { RegistryAdapter, RegistryAdapterConfig, toAdapterConfig } from './types';
import { GHCRAdapter } from './ghcr';
import { DockerHubAdapter } from './dockerhub';
import { ECRAdapter } from './ecr';
import { CustomRegistryAdapter } from './custom';
import { AppDefinition, AppRegistry } from '../../models/app';

export * from './types';
export { GHCRAdapter } from './ghcr';
export { DockerHubAdapter } from './dockerhub';
export { ECRAdapter } from './ecr';
export { CustomRegistryAdapter } from './custom';

// Per-app adapter cache
const adapterCache = new Map<string, RegistryAdapter>();

/**
 * Create a registry adapter from adapter config
 */
export function createRegistryAdapter(adapterConfig: RegistryAdapterConfig): RegistryAdapter {
  switch (adapterConfig.type) {
    case 'ghcr':
      return new GHCRAdapter(adapterConfig);
    case 'dockerhub':
      return new DockerHubAdapter(adapterConfig);
    case 'ecr':
      return new ECRAdapter(adapterConfig);
    case 'custom':
      return new CustomRegistryAdapter(adapterConfig);
    default:
      throw new Error(`Unsupported registry type: ${adapterConfig.type}`);
  }
}

/**
 * Convert an app's registry config to adapter config
 */
function appRegistryToAdapterConfig(registry: AppRegistry): RegistryAdapterConfig {
  return {
    type: registry.type,
    url: registry.url,
    repository: registry.repository,
    username: registry.auth.username_env ? process.env[registry.auth.username_env] : undefined,
    token: registry.auth.token_env ? process.env[registry.auth.token_env] : undefined,
    awsRegion: registry.auth.aws_region_env ? process.env[registry.auth.aws_region_env] : undefined,
    tagPattern: registry.tag_pattern ? new RegExp(registry.tag_pattern) : undefined,
  };
}

/**
 * Get or create a registry adapter for a specific app
 */
export function getRegistryAdapterForApp(app: AppDefinition): RegistryAdapter {
  let adapter = adapterCache.get(app.id);
  if (!adapter) {
    const config = appRegistryToAdapterConfig(app.registry);
    adapter = createRegistryAdapter(config);
    adapterCache.set(app.id, adapter);
  }
  return adapter;
}

/**
 * Clear the adapter cache (useful for config changes)
 */
export function clearAdapterCache(): void {
  adapterCache.clear();
}

/**
 * Login to registry for a specific app
 */
export async function loginToRegistryForApp(app: AppDefinition): Promise<void> {
  const adapter = getRegistryAdapterForApp(app);
  await adapter.login();
}

/**
 * Login to registries for all apps
 */
export async function loginToAllRegistries(apps: AppDefinition[]): Promise<void> {
  for (const app of apps) {
    try {
      await loginToRegistryForApp(app);
      console.log(`Registry login successful for app '${app.id}'`);
    } catch (error) {
      console.error(`Warning: Registry login failed for app '${app.id}':`, error);
    }
  }
}

/**
 * Get available image tags for a specific app
 */
export async function getImageTagsForApp(app: AppDefinition): Promise<string[]> {
  const adapter = getRegistryAdapterForApp(app);
  return adapter.getImageTags();
}
