import { ValidationError } from '../utils/httpErrors';

/**
 * The names Overwatch derives from an (appId, tenantId) pair: the compose
 * project, container, Traefik router and owned volume names, and the database
 * identifier. Build them here so the scheme is defined once.
 *
 * App and tenant ids are slugs (`[a-z0-9-]`), and `-` also joins the parts of
 * a derived name, so `shop` + `eu-api` and `shop-eu` + `api` derive the same
 * names. `findIdentityConflict` lets tenant create refuse such a tenant.
 * Existing tenants keep the names they were created with: the schemes below
 * are the ones Overwatch has always used, except that `-` becomes `_` in the
 * DB id (database identifiers only allow `[a-z0-9_]`, so a hyphenated id
 * never got a database before).
 */
export interface TenantIdentity {
  appId: string;
  tenantId: string;
  /** `COMPOSE_PROJECT_NAME` written to a new tenant's `.env`. */
  composeProject: string;
  /** Prefix of the tenant's container, Traefik router and owned volume names. */
  namePrefix: string;
  /** Handed to the database adapter, which prepends the app's db_prefix. */
  dbId: string;
}

export function tenantIdentity(appId: string, tenantId: string): TenantIdentity {
  return {
    appId,
    tenantId,
    composeProject: `${appId}-${tenantId}`,
    namePrefix: `${appId}-${tenantId}-`,
    dbId: `${appId}_${tenantId}`.replace(/-/g, '_'),
  };
}

/** Container name of one service; Traefik routers use the same name. */
export function containerName(appId: string, tenantId: string, service: string): string {
  return `${tenantIdentity(appId, tenantId).namePrefix}${service}`;
}

/** Volume name scoped to one tenant of one app. */
export function tenantVolumeName(appId: string, tenantId: string, base: string): string {
  return `${tenantIdentity(appId, tenantId).namePrefix}${base}`;
}

/**
 * Whether a volume name belongs to this tenant alone. Only those are left to
 * compose (and so removed by `down -v`); any other name may hold another
 * tenant's data.
 */
export function isTenantOwnedVolume(name: string, appId: string, tenantId: string): boolean {
  const prefix = tenantIdentity(appId, tenantId).namePrefix;
  return name.length > prefix.length && name.startsWith(prefix);
}

/** Names one tenant uses (an existing tenant) or would use (a tenant being created). */
export interface TenantNames {
  appId: string;
  tenantId: string;
  composeProject: string;
  namePrefix: string;
  /** Full database name (db_prefix applied); unknown for a tenant without one. */
  dbName?: string;
  containerNames?: string[];
  /** For a candidate: the volumes it would own. For an existing tenant: every volume it declares. */
  volumeNames?: string[];
}

/**
 * The first name `candidate` would share with an existing tenant, as a message,
 * or null. Sharing a compose project lets one tenant's `down` remove the other's
 * containers; sharing a database or a volume mixes their data.
 */
export function findIdentityConflict(candidate: TenantNames, existing: TenantNames[]): string | null {
  for (const other of existing) {
    if (other.appId === candidate.appId && other.tenantId === candidate.tenantId) continue;
    const owner = `tenant '${other.tenantId}' of app '${other.appId}'`;
    if (other.composeProject === candidate.composeProject) {
      return `the compose project '${candidate.composeProject}' is already used by ${owner}`;
    }
    if (other.namePrefix === candidate.namePrefix) {
      return `the container name prefix '${candidate.namePrefix}' is already used by ${owner}`;
    }
    if (candidate.dbName && other.dbName === candidate.dbName) {
      return `the database '${candidate.dbName}' is already used by ${owner}`;
    }
    const container = candidate.containerNames?.find(n => other.containerNames?.includes(n));
    if (container) return `the container '${container}' is already used by ${owner}`;
    const volume = candidate.volumeNames?.find(n => other.volumeNames?.includes(n));
    if (volume) return `the volume '${volume}' is already used by ${owner}`;
  }
  return null;
}

/**
 * Longest tenant database name each engine accepts. The adapters create a
 * user with the same name as the database, and MySQL 5.7+ caps user names at
 * 32 characters (MariaDB allows 80, so its 64-character database limit applies).
 */
const DB_NAME_LIMITS: Record<string, { max: number; what: string }> = {
  mysql: { max: 32, what: 'MySQL allows at most 32 characters for the database user name' },
  mariadb: { max: 64, what: 'MariaDB allows at most 64 characters for a database name' },
  postgres: { max: 63, what: 'PostgreSQL allows at most 63 characters for a database name' },
};

/**
 * Check a new tenant's database name before anything is created, so a name the
 * server would refuse fails with a clear message instead of a rollback.
 */
export function assertTenantDbName(dbName: string, dbType: string | undefined): void {
  if (!/^[a-z0-9_]+$/.test(dbName)) {
    throw new ValidationError(
      `The tenant database name "${dbName}" may only contain lowercase letters, digits and "_". Check the app's db_prefix.`,
    );
  }
  const limit = DB_NAME_LIMITS[dbType ?? ''] ?? { max: 63, what: 'database names are limited to 63 characters' };
  if (dbName.length > limit.max) {
    throw new ValidationError(
      `The tenant database name "${dbName}" is ${dbName.length} characters long, but ${limit.what}. ` +
      `Use a tenant ID that is ${dbName.length - limit.max} or more characters shorter.`,
    );
  }
}
