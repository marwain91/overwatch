import { ValidationError } from './httpErrors';

/** Slug pattern: lowercase alphanumeric with hyphens (tenant IDs, app IDs) */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

/** Docker container ID: 12 or 64 hex characters */
export const CONTAINER_ID_RE = /^[a-f0-9]{12,64}$/;

/** Restic snapshot ID: 8-64 hex characters */
export const SNAPSHOT_ID_RE = /^[a-f0-9]{8,64}$/;

/** Docker container name */
export const CONTAINER_NAME_RE = /^[a-z0-9][a-z0-9_.-]*$/;

/** UUID v4 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Basic email validation */
// Bounded quantifiers cap input length and rule out the polynomial-backtracking shape CodeQL flagged.
export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{1,63}$/;

export function isValidSlug(id: string, maxLength: number = 63): boolean {
  return id.length <= maxLength && SLUG_RE.test(id);
}

/**
 * Write-path check for app definitions: service names end up in container
 * names, labels and compose keys, so new input must be slugs. Stored
 * definitions are not re-checked here, so existing odd names keep loading.
 */
export function assertServiceNamesValid(services: unknown): void {
  if (!Array.isArray(services)) return;
  for (const svc of services) {
    const name = svc?.name;
    if (typeof name === 'string' && !isValidSlug(name)) {
      throw new ValidationError(`Invalid service name ${JSON.stringify(name)}: use lowercase letters, digits and hyphens`);
    }
  }
}

/**
 * Docker's rule for a named volume. Compose reads anything else in a
 * `source:target` mount as a host path (`/var/run/docker.sock`, `./data`,
 * `~/x`), splits it at a `:`, or interpolates a `$`.
 */
export const VOLUME_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export function isSafeVolumeName(name: string): boolean {
  return VOLUME_NAME_RE.test(name);
}

export interface VolumeNameIssue {
  /** Path below the services array, e.g. [0, 'volumes', 1, 'name']. */
  path: Array<string | number>;
  message: string;
}

/**
 * Write-path problems with the volume names in an app definition. A
 * `name_template` is checked with its `${appId}` / `${tenantId}` placeholders
 * filled in. Stored definitions are not re-checked, so existing apps keep
 * loading; the compose generator warns about them instead.
 */
export function volumeNameIssues(services: unknown): VolumeNameIssue[] {
  const issues: VolumeNameIssue[] = [];
  if (!Array.isArray(services)) return issues;
  services.forEach((svc, i) => {
    const volumes = svc?.volumes;
    if (!Array.isArray(volumes)) return;
    volumes.forEach((vol, j) => {
      for (const field of ['name', 'name_template'] as const) {
        const value = vol?.[field];
        if (typeof value !== 'string') continue;
        const filled = field === 'name_template' ? value.replace(/\$\{(appId|tenantId)\}/g, 'x') : value;
        if (!isSafeVolumeName(filled)) {
          issues.push({
            path: [i, 'volumes', j, field],
            message: `Invalid volume ${field} ${JSON.stringify(value)}: use letters, digits, "_", "." and "-", starting with a letter or digit (a path or a ":" would mount a host directory)`,
          });
        }
      }
    });
  });
  return issues;
}

/** `volumeNameIssues` for write paths that validate outside Zod (the CLI). */
export function assertVolumeNamesValid(services: unknown): void {
  const [first] = volumeNameIssues(services);
  if (first) throw new ValidationError(`services.${first.path.join('.')}: ${first.message}`);
}

/** Compose healthcheck duration: one or more `<number><unit>` parts, e.g. `30s`, `1m30s`, `500ms`. */
export const COMPOSE_DURATION_RE = /^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/;

export function isValidComposeDuration(value: unknown): boolean {
  return typeof value === 'string' && COMPOSE_DURATION_RE.test(value);
}

/**
 * Write-path check for app definitions: a bad healthcheck duration makes
 * `docker compose up` reject the whole tenant file, so new input must use
 * Compose duration syntax. Stored definitions are not re-checked here (the
 * generator warns and falls back instead), so existing apps keep loading.
 */
export function assertHealthcheckDurationsValid(services: unknown): void {
  if (!Array.isArray(services)) return;
  for (const svc of services) {
    const hc = svc?.health_check;
    if (!hc || typeof hc !== 'object') continue;
    for (const field of ['interval', 'timeout', 'start_period'] as const) {
      const value = hc[field];
      if (value === undefined || value === '') continue;
      if (!isValidComposeDuration(value)) {
        throw new ValidationError(
          `Invalid health_check.${field} ${JSON.stringify(value)} for service ${JSON.stringify(svc?.name)}: use a duration such as 30s, 1m30s or 500ms`,
        );
      }
    }
  }
}

export function isValidContainerId(id: string): boolean {
  return CONTAINER_ID_RE.test(id);
}

export function isValidSnapshotId(id: string): boolean {
  return SNAPSHOT_ID_RE.test(id);
}

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_RE.test(email);
}
