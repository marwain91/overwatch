import { createHash } from 'crypto';
import { RegistryAdapter, RegistryAdapterConfig } from './types';
import { RegistryLoginTarget, holdRegistryLogin, runWithRegistryLogin } from './login';
import { assertRegistryUsable } from './validation';
import { GHCRAdapter } from './ghcr';
import { GitLabAdapter } from './gitlab';
import { DockerHubAdapter } from './dockerhub';
import { ECRAdapter } from './ecr';
import { CustomRegistryAdapter } from './custom';
import { isReservedSecretEnv, loadConfigOrNull } from '../../utils/reservedEnv';
import { AppDefinition, AppRegistry } from '../../models/app';

export * from './types';
export { GHCRAdapter } from './ghcr';
export { GitLabAdapter } from './gitlab';
export { DockerHubAdapter } from './dockerhub';
export { ECRAdapter } from './ecr';
export { CustomRegistryAdapter } from './custom';
export { REGISTRY_LOGIN_TTL_MS, REGISTRY_LOGIN_HOLD_MS, RegistryLoginUnavailableError } from './login';

// Per-app adapter cache
const adapterCache = new Map<string, { adapter: RegistryAdapter; config: RegistryAdapterConfig }>();

/**
 * Create a registry adapter from adapter config
 */
export function createRegistryAdapter(adapterConfig: RegistryAdapterConfig): RegistryAdapter {
  switch (adapterConfig.type) {
    case 'ghcr':
      return new GHCRAdapter(adapterConfig);
    case 'gitlab':
      return new GitLabAdapter(adapterConfig);
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
  const auth = registry.auth;
  const config = loadConfigOrNull();
  for (const [field, envName] of [['token_env', auth.token_env], ['username_env', auth.username_env]] as const) {
    if (envName && isReservedSecretEnv(envName, config, { forRegistryAuth: true })) {
      throw new Error(`registry.auth.${field} '${envName}' is a reserved Overwatch secret and cannot be used as a registry credential`);
    }
  }
  return {
    type: registry.type,
    url: registry.url,
    apiUrl: registry.api_url,
    repository: registry.repository,
    username: auth.username_env ? process.env[auth.username_env] : undefined,
    token: auth.token_env ? process.env[auth.token_env] : undefined,
    awsRegion: auth.aws_region_env ? process.env[auth.aws_region_env] : undefined,
    tagPattern: registry.tag_pattern ? new RegExp(registry.tag_pattern) : undefined,
  };
}

/**
 * Get or create a registry adapter for a specific app
 */
export function getRegistryAdapterForApp(app: AppDefinition): RegistryAdapter {
  return cachedAdapterForApp(app).adapter;
}

function cachedAdapterForApp(app: AppDefinition): { adapter: RegistryAdapter; config: RegistryAdapterConfig } {
  let entry = adapterCache.get(app.id);
  if (!entry) {
    const config = appRegistryToAdapterConfig(app.registry);
    entry = { adapter: createRegistryAdapter(config), config };
    adapterCache.set(app.id, entry);
  }
  return entry;
}

/**
 * Drop the cached adapter for a single app (call this after the app's
 * registry config changes so the next pull/login uses the new auth/repo).
 * Pass undefined / no argument to clear the whole cache.
 */
export function clearAdapterCache(appId?: string): void {
  if (appId === undefined) {
    adapterCache.clear();
  } else {
    adapterCache.delete(appId);
  }
}

// Docker keys stored credentials by registry host; a Docker Hub login names no server.
function loginHost(config: RegistryAdapterConfig): string {
  if (config.type === 'dockerhub') return 'docker.io';
  return config.url.split('/')[0].toLowerCase();
}

/**
 * The app's registry login, or null when the app has no registry credentials.
 * Throws when the registry config is unusable (reserved credential env, invalid
 * tag_pattern).
 */
function loginTargetForApp(app: AppDefinition): RegistryLoginTarget | null {
  const { adapter, config } = cachedAdapterForApp(app);
  if (!adapter.hasCredentials()) return null;
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([config.type, config.url, config.username ?? null, config.token ?? null, config.awsRegion ?? null]))
    .digest('hex');
  return { host: loginHost(config), fingerprint, label: `app '${app.id}'`, login: () => adapter.login() };
}

// Such a config only ever broke tag listing and the boot login; the app's
// pulls still ran, so they keep running, without a login.
function pullLoginTarget(app: AppDefinition): RegistryLoginTarget | null {
  try {
    return loginTargetForApp(app);
  } catch (err) {
    console.warn(`[registry] No registry login for app '${app.id}': ${err instanceof Error ? err.message : err}. Pulling with the existing docker credentials.`);
    return null;
  }
}

/**
 * Log in to the app's registry right before a pull, so apps added after boot,
 * rotated credentials and expired ECR tokens work without a restart. Apps
 * without registry credentials are left alone: their pulls use whatever docker
 * login state exists, as before.
 *
 * A login is reused per registry host and credential for REGISTRY_LOGIN_TTL_MS.
 * Docker keeps one credential per host, and the docker CLI and compose read it
 * when they start, so another app's different credential for the same host
 * waits REGISTRY_LOGIN_HOLD_MS for the caller's pull to start.
 *
 * A failed or impossible login does not fail the pull: it is logged as a
 * warning and the pull runs with the existing docker credentials. Registry
 * settings with an invalid url or repository refuse the pull.
 */
export async function ensureRegistryLogin(app: AppDefinition): Promise<void> {
  assertRegistryUsable(app, 'pull');
  const target = pullLoginTarget(app);
  if (target) await holdRegistryLogin(target);
}

/**
 * ensureRegistryLogin that keeps the registry host for the app's credential
 * until `fn` settles rather than for REGISTRY_LOGIN_HOLD_MS.
 */
export async function withRegistryLogin<T>(app: AppDefinition, fn: () => Promise<T>): Promise<T> {
  assertRegistryUsable(app, 'pull');
  const target = pullLoginTarget(app);
  return target ? runWithRegistryLogin(target, fn) : fn();
}

/**
 * Login to registry for a specific app
 */
export async function loginToRegistryForApp(app: AppDefinition): Promise<void> {
  assertRegistryUsable(app, 'pull');
  const target = loginTargetForApp(app);
  if (!target) {
    console.log(`Registry credentials not configured for app '${app.id}', skipping registry login`);
    return;
  }
  await runWithRegistryLogin(target, async () => undefined);
}

/**
 * Login to registries for all apps. Pulls log in again when they need to;
 * this only warms the login cache at boot.
 */
export async function loginToAllRegistries(apps: AppDefinition[]): Promise<void> {
  for (const app of apps) {
    try {
      await loginToRegistryForApp(app);
    } catch (error) {
      console.error(`Warning: Registry login failed for app '${app.id}':`, error);
    }
  }
}

/**
 * Get available image tags for a specific app
 */
export async function getImageTagsForApp(app: AppDefinition): Promise<string[]> {
  assertRegistryUsable(app, 'list tags');
  const adapter = getRegistryAdapterForApp(app);
  return adapter.getImageTags();
}
