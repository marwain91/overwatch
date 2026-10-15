import { resolveAppDbPrefix } from '../config';
import { readTenantEnv } from './tenantStore';
import type { AppDefinition } from '../models/app';
import { tenantIdentity } from './tenantIdentity';

/**
 * Identifier to hand to the database adapter for a tenant.
 *
 * The adapter prepends the app's effective db_prefix, so this is the tenant's
 * derived DB id (`appId_tenantId`, `-` mapped to `_`) unless the tenant's .env carries a DB_NAME (migrated tenants), in which case the
 * prefix is stripped from it. Shared by delete, backup and restore so all three
 * address the same database.
 */
export async function resolveTenantDbId(
  appId: string,
  tenantId: string,
  app?: Pick<AppDefinition, 'db_prefix'> | null,
): Promise<string> {
  const fallback = tenantIdentity(appId, tenantId).dbId;
  try {
    const env = await readTenantEnv(appId, tenantId);
    if (!env.DB_NAME) return fallback;
    const effectivePrefix = resolveAppDbPrefix(app ?? undefined);
    if (!effectivePrefix) return env.DB_NAME;
    const prefix = `${effectivePrefix}_`;
    return env.DB_NAME.startsWith(prefix) ? env.DB_NAME.slice(prefix.length) : env.DB_NAME;
  } catch {
    return fallback;
  }
}
