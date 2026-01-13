import { loadConfig } from '../../config';
import { RegistryAdapter, RegistryAdapterConfig, toAdapterConfig } from './types';
import { GHCRAdapter } from './ghcr';
import { DockerHubAdapter } from './dockerhub';
import { ECRAdapter } from './ecr';
import { CustomRegistryAdapter } from './custom';

export * from './types';
export { GHCRAdapter } from './ghcr';
export { DockerHubAdapter } from './dockerhub';
export { ECRAdapter } from './ecr';
export { CustomRegistryAdapter } from './custom';

let cachedAdapter: RegistryAdapter | null = null;

/**
 * Create a registry adapter based on the configuration
 */
export function createRegistryAdapter(adapterConfig?: RegistryAdapterConfig): RegistryAdapter {
  const config = adapterConfig || getAdapterConfigFromOverwatch();

  switch (config.type) {
    case 'ghcr':
      return new GHCRAdapter(config);
    case 'dockerhub':
      return new DockerHubAdapter(config);
    case 'ecr':
      return new ECRAdapter(config);
    case 'custom':
      return new CustomRegistryAdapter(config);
    default:
      throw new Error(`Unsupported registry type: ${config.type}`);
  }
}

/**
 * Get a singleton registry adapter instance based on the Overwatch configuration
 */
export function getRegistryAdapter(): RegistryAdapter {
  if (!cachedAdapter) {
    cachedAdapter = createRegistryAdapter();
  }
  return cachedAdapter;
}

/**
 * Clear the cached adapter (useful for testing or config changes)
 */
export function clearAdapterCache(): void {
  cachedAdapter = null;
}

/**
 * Login to the configured registry
 */
export async function loginToRegistry(): Promise<void> {
  const adapter = getRegistryAdapter();
  await adapter.login();
}

/**
 * Get available image tags from the configured registry
 */
export async function getImageTags(): Promise<string[]> {
  const adapter = getRegistryAdapter();
  return adapter.getImageTags();
}

/**
 * Convert Overwatch config to adapter config
 */
function getAdapterConfigFromOverwatch(): RegistryAdapterConfig {
  const config = loadConfig();
  return toAdapterConfig(config.registry);
}
