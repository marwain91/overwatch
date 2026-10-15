import { resolveAppDbPrefix } from '../config';
import { readTenantEnv } from './tenantStore';
import type { AppDefinition } from '../models/app';
import { tenantIdentity } from './tenantIdentity';
import { ConflictError } from '../utils/httpErrors';

/**
 * Identifier to hand to the database adapter for a tenant.
 *
 * The adapter prepends the app's effective db_prefix, so this is the tenant's
 * derived DB id (`appId_tenantId`, `-` mapped to `_`) unless the tenant's .env
 * carries a DB_NAME (migrated tenants), in which case the prefix is stripped
 * from it. Used by backup and restore.
 */
export async function resolveTenantDbId(
  appId: string,
  tenantId: string,
  app?: Pick<AppDefinition, 'db_prefix'> | null,
): Promise<string> {
  const fallback = tenantIdentity(appId, tenantId).dbId;
  let env: Record<string, string>;
  try {
    env = await readTenantEnv(appId, tenantId);
  } catch (err: any) {
    // Only a missing .env means "use the derived name"; an unreadable one must not.
    if (err?.code === 'ENOENT') return fallback;
    throw err;
  }
  if (!env.DB_NAME) return fallback;
  const effectivePrefix = resolveAppDbPrefix(app ?? undefined);
  if (!effectivePrefix) return env.DB_NAME;
  const prefix = `${effectivePrefix}_`;
  return env.DB_NAME.startsWith(prefix) ? env.DB_NAME.slice(prefix.length) : env.DB_NAME;
}

/**
 * The full name of the database a tenant uses, for dropping it: the tenant's
 * .env DB_NAME (what the tenant actually connects to, whatever prefix it was
 * created with), else the derived id with the tenant definition's db_prefix.
 * Throws when neither can be established, so a delete fails closed instead of
 * dropping a guessed name and orphaning the real database.
 */
export async function resolveTenantDbName(
  appId: string,
  tenantId: string,
  app: Pick<AppDefinition, 'db_prefix'> | null,
): Promise<string> {
  const unknown = (why: string) => new ConflictError(
    `Cannot determine the database of tenant '${tenantId}' (app '${appId}'): ${why}. ` +
    'Nothing was deleted. Delete it with "keep data" and drop its database by hand, or fix the cause and retry.',
  );
  let env: Record<string, string>;
  try {
    env = await readTenantEnv(appId, tenantId);
  } catch (err: any) {
    throw unknown(err?.code === 'ENOENT' ? 'its .env is missing' : `its .env cannot be read (${err?.code || err?.message || err})`);
  }
  let name = env.DB_NAME;
  if (!name) {
    if (!app) throw unknown('its .env has no DB_NAME and no app definition is left to derive the name from');
    const prefix = resolveAppDbPrefix(app);
    const dbId = tenantIdentity(appId, tenantId).dbId;
    name = prefix ? `${prefix}_${dbId}` : dbId;
  }
  if (!/^[a-z0-9_]+$/.test(name)) throw unknown(`the database name ${JSON.stringify(name)} is not a valid identifier`);
  return name;
}
