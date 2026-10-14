import type { OverwatchConfig } from '../config/schema';

/**
 * Env names that hold Overwatch's own secrets (see templates/overwatch/docker-compose.yml).
 * An app definition must never point a signing key or registry credential at one of
 * these: the app would then sign tokens with, or hand to a registry, a secret that
 * guards the whole deployment. AUTH_SERVICE_SECRET is deliberately absent; it is the
 * tenant-admin secret.
 */
const RESERVED_SECRET_ENVS: ReadonlySet<string> = new Set([
  'JWT_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'MYSQL_ROOT_PASSWORD',
  'POSTGRES_PASSWORD',
  'RESTIC_PASSWORD',
  'GHCR_TOKEN',
]);

// Backup storage credentials (R2_*) and AWS credentials.
const RESERVED_SECRET_PREFIXES = ['R2_', 'AWS_'];

// Registry credentials that Overwatch itself uses to pull images. Referencing them
// as a registry token is the documented default, so only non-registry uses are refused.
const REGISTRY_CREDENTIAL_ENVS: ReadonlySet<string> = new Set(['GHCR_TOKEN']);

type ConfigLike = Pick<OverwatchConfig, 'database'> | { database?: { root_password_env?: string } } | null | undefined;

/**
 * True when `name` is an Overwatch core secret env. `config` supplies the
 * configurable DB root password env; pass null when config is unavailable and
 * only the static list applies.
 * `forRegistryAuth` allows the registry credential envs (GHCR_TOKEN).
 */
export function isReservedSecretEnv(
  name: string,
  config?: ConfigLike,
  options: { forRegistryAuth?: boolean } = {},
): boolean {
  if (!name) return false;
  if (options.forRegistryAuth && REGISTRY_CREDENTIAL_ENVS.has(name)) return false;
  if (RESERVED_SECRET_ENVS.has(name)) return true;
  if (RESERVED_SECRET_PREFIXES.some(p => name.startsWith(p))) return true;
  const dbEnv = config?.database?.root_password_env;
  return !!dbEnv && name === dbEnv;
}
