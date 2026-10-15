import { Router, Request, Response } from 'express';
import {
  listEnvVars,
  setEnvVar,
  deleteEnvVar,
  getEffectiveEnvVars,
  setTenantOverride,
  deleteTenantOverride,
  regenerateAllSharedEnvFiles,
  regenerateTenantSharedEnv,
} from '../services/envVars';
import { adminAccessSecretEnvs } from '../services/adminAccess';
import { can } from '../services/users';
import { asyncHandler } from '../utils/asyncHandler';
import { validateTenantId } from '../middleware/validators';
import { requireRole } from '../middleware/requireRole';
import type { AuthUser } from '../middleware/auth';

// A busy tenant is not a failure: the value is saved and its shared.env is
// regenerated in the background once the running operation releases the tenant.
function busyWarnings(busy: string[]): { warnings?: string[] } {
  return busy.length
    ? { warnings: busy.map(id => `${id} is busy; its shared.env will be updated when the current operation finishes`) }
    : {};
}

const MASK = '••••••••';

function isAdmin(res: Response): boolean {
  const user = res.locals.user as AuthUser | undefined;
  return !!user && can(user.role, 'admin');
}

/**
 * Keys only an admin may write or read unmasked: AUTH_SERVICE_SECRET and every
 * app's admin_access.secret_env. shared.env outranks the tenant's .env and
 * image ENV, so whoever sets the secret a tenant verifies admin tokens with
 * can sign the {isSystemAdmin:true} tokens that only an admin may mint.
 */
async function adminOnlyKeys(): Promise<(key: string) => boolean> {
  const secretEnvs = await adminAccessSecretEnvs();
  return key => secretEnvs.has(key);
}

/** Sends a 403 and returns true when a non-admin targets an admin-only key. */
async function refuseAdminOnlyKey(res: Response, key: unknown): Promise<boolean> {
  if (isAdmin(res)) return false;
  // Trimmed like validateEnvVarKey, so padding cannot slip a key past this check.
  const name = String(key).trim();
  if (!(await adminOnlyKeys())(name)) return false;
  res.status(403).json({ error: `Only an admin can change ${name}: it holds the secret tenants verify admin tokens with` });
  return true;
}

/** Masks sensitive values; for non-admins also every admin-only key, whatever its flag. */
async function masker(res: Response): Promise<<T extends { key: string; value: string; sensitive: boolean }>(v: T) => T> {
  const hidden = isAdmin(res) ? () => false : await adminOnlyKeys();
  return v => (hidden(v.key)
    ? { ...v, value: MASK, sensitive: true }
    : { ...v, value: v.sensitive ? MASK : v.value });
}

const router = Router({ mergeParams: true });

// List global env vars for an app (sensitive values masked)
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const { appId } = (req.params as Record<string, string>);
  const vars = await listEnvVars(appId);
  res.json(vars.map(await masker(res)));
}));

// Create or update a global env var for an app — editor+
router.post('/', requireRole('editor'), asyncHandler(async (req: Request, res: Response) => {
  const { appId } = (req.params as Record<string, string>);
  const { key, value, sensitive, description } = req.body;

  if (!key) {
    return res.status(400).json({ error: 'Key is required' });
  }
  if (await refuseAdminOnlyKey(res, key)) return;
  // Strict boolean: a falsy non-boolean (0, "") would skip the unmask guard
  // below and be stored as a non-sensitive flag.
  if (sensitive !== undefined && sensitive !== null && typeof sensitive !== 'boolean') {
    return res.status(400).json({ error: 'sensitive must be a boolean' });
  }
  // env-vars.json is schema-validated on every read, so a wrongly typed field
  // saved here would break env vars for every app until fixed by hand.
  if (description !== undefined && description !== null && typeof description !== 'string') {
    return res.status(400).json({ error: 'description must be a string' });
  }

  const existing = (await listEnvVars(appId)).find(v => v.key === key);

  // When value is omitted, keep the existing value (for sensitive field edits)
  let effectiveValue: string;
  if (value === undefined || value === null || value === '') {
    // Masked secrets are never readable through the API, so clearing the flag
    // without supplying a value would let the caller reveal one they can't see.
    if (existing?.sensitive && sensitive === false) {
      return res.status(400).json({ error: 'Re-enter the value to make a sensitive variable non-sensitive' });
    }
    if (existing) {
      effectiveValue = existing.value;
    } else {
      return res.status(400).json({ error: 'Value is required for new variables' });
    }
  } else {
    effectiveValue = String(value);
  }

  // An omitted flag keeps the stored one: defaulting to false would unmask an
  // existing secret in GET /env-vars on any edit that doesn't re-send it.
  const envVar = await setEnvVar(appId, key, effectiveValue, sensitive ?? existing?.sensitive ?? false, description ?? undefined);
  const busy: string[] = [];
  const tenantsAffected = await regenerateAllSharedEnvFiles(appId, { busy });

  res.json({
    envVar: { ...envVar, value: envVar.sensitive ? MASK : envVar.value },
    tenantsAffected,
    ...busyWarnings(busy),
  });
}));

// Delete a global env var for an app — editor+
router.delete('/:key', requireRole('editor'), asyncHandler(async (req: Request, res: Response) => {
  const { appId, key } = (req.params as Record<string, string>);
  if (await refuseAdminOnlyKey(res, key)) return;
  await deleteEnvVar(appId, key);
  const busy: string[] = [];
  const tenantsAffected = await regenerateAllSharedEnvFiles(appId, { busy });
  res.json({ success: true, tenantsAffected, ...busyWarnings(busy) });
}));

// Get effective env vars for a tenant (merged view)
router.get('/tenants/:tenantId', validateTenantId, asyncHandler(async (req: Request, res: Response) => {
  const { appId, tenantId } = (req.params as Record<string, string>);
  const effective = await getEffectiveEnvVars(appId, tenantId);
  res.json(effective.map(await masker(res)));
}));

// Set a tenant override — editor+
router.post('/tenants/:tenantId/overrides', validateTenantId, requireRole('editor'), asyncHandler(async (req: Request, res: Response) => {
  const { appId, tenantId } = (req.params as Record<string, string>);
  const { key, value, sensitive } = req.body;

  if (!key || value === undefined || value === null) {
    return res.status(400).json({ error: 'Key and value are required' });
  }
  if (await refuseAdminOnlyKey(res, key)) return;
  // tenant-env-overrides.json is schema-validated on every read; a non-boolean
  // flag saved here would break overrides for every app.
  if (sensitive !== undefined && sensitive !== null && typeof sensitive !== 'boolean') {
    return res.status(400).json({ error: 'sensitive must be a boolean' });
  }

  await setTenantOverride(appId, tenantId, key, String(value), sensitive ?? undefined);
  const { busy } = await regenerateTenantSharedEnv(appId, tenantId);

  res.json({ success: true, ...busyWarnings(busy ? [`${appId}/${tenantId}`] : []) });
}));

// Delete a tenant override — editor+
router.delete('/tenants/:tenantId/overrides/:key', validateTenantId, requireRole('editor'), asyncHandler(async (req: Request, res: Response) => {
  const { appId, tenantId, key } = (req.params as Record<string, string>);
  if (await refuseAdminOnlyKey(res, key)) return;
  await deleteTenantOverride(appId, tenantId, key);
  const { busy } = await regenerateTenantSharedEnv(appId, tenantId);

  res.json({ success: true, ...busyWarnings(busy ? [`${appId}/${tenantId}`] : []) });
}));

export default router;
