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
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidSlug(id: string, maxLength: number = 63): boolean {
  return id.length <= maxLength && SLUG_RE.test(id);
}

export function isValidContainerId(id: string): boolean {
  return CONTAINER_ID_RE.test(id);
}

export function isValidSnapshotId(id: string): boolean {
  return SNAPSHOT_ID_RE.test(id);
}

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}
