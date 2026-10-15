import jwt from 'jsonwebtoken';
import { getApp, listApps } from './app';
import { getTenantInfo } from './docker';
import { isReservedSecretEnv, loadConfigOrNull } from '../utils/reservedEnv';
import { HttpError, NotFoundError, ValidationError } from '../utils/httpErrors';

const DEFAULT_URL_TEMPLATE = 'https://${domain}/admin-login#token=${token}';
const DEFAULT_SECRET_ENV = 'AUTH_SERVICE_SECRET';

function fillPlaceholder(template: string, name: string, value: string): string {
  // split/join: replaces every occurrence and never interprets `$` in the value.
  return template.split('${' + name + '}').join(value);
}

/**
 * Mint a short-lived JWT that logs the bearer in as system admin of a tenant,
 * plus the login URL rendered from the app's url_template. Highest-privilege
 * operation in the system; callers must already have enforced the admin role.
 */
export async function mintAdminAccess(appId: string, tenantId: string): Promise<{ accessUrl: string; token: string }> {
  const app = await getApp(appId);
  if (!app) throw new NotFoundError('App not found');

  const adminAccess = app.admin_access;
  if (!adminAccess?.enabled) {
    throw new ValidationError('Admin access is not enabled for this app');
  }

  const secretEnv = adminAccess.secret_env || DEFAULT_SECRET_ENV;

  // Tokens signed with an Overwatch core secret (e.g. JWT_SECRET) would be valid
  // against Overwatch itself; refuse before reading the value.
  if (isReservedSecretEnv(secretEnv, loadConfigOrNull())) {
    console.error(`[AdminAccess] Refusing to mint for app ${appId}: secret_env '${secretEnv}' is a reserved Overwatch secret`);
    throw new ValidationError(
      `admin_access.secret_env '${secretEnv}' is a reserved Overwatch secret and cannot sign tenant admin tokens. Use a dedicated env such as AUTH_SERVICE_SECRET.`,
    );
  }
  const secret = process.env[secretEnv];
  if (!secret) {
    console.error(`[AdminAccess] Secret env '${secretEnv}' not configured for app ${appId}`);
    throw new HttpError(500, 'Admin access is not properly configured. Contact your administrator.', { expose: true });
  }

  const tenantInfo = await getTenantInfo(appId, tenantId);
  if (!tenantInfo) throw new NotFoundError('Tenant not found');

  const tokenPayload = adminAccess.token_payload;
  const adminFlag = tokenPayload?.admin_flag || 'isSystemAdmin';
  const emailTemplate = tokenPayload?.email_template || `admin@${app.name}.local`;
  const adminName = tokenPayload?.name || 'System Admin';

  const token = jwt.sign(
    {
      [adminFlag]: true,
      appId,
      tenantId,
      email: fillPlaceholder(emailTemplate, 'tenantId', tenantId),
      name: adminName,
      iat: Math.floor(Date.now() / 1000),
    },
    secret,
    { expiresIn: '1h' },
  );

  const urlTemplate = adminAccess.url_template || DEFAULT_URL_TEMPLATE;
  // Defence in depth: re-validate the pinned prefix at mint time. The schema
  // enforces it at write, but this catches a template that bypassed it
  // (e.g. hand-edited apps.json).
  if (!/^https:\/\/\$\{domain\}/.test(urlTemplate)) {
    console.error(`[AdminAccess] url_template rejected at runtime for ${appId}: ${urlTemplate}`);
    throw new HttpError(500, 'Admin access URL template is invalid; contact administrator.', { expose: true });
  }
  let accessUrl = fillPlaceholder(urlTemplate, 'domain', encodeURIComponent(tenantInfo.domain));
  accessUrl = fillPlaceholder(accessUrl, 'token', encodeURIComponent(token));
  accessUrl = fillPlaceholder(accessUrl, 'tenantId', encodeURIComponent(tenantId));

  return { accessUrl, token };
}

/**
 * Env names that hold the secret a tenant verifies admin tokens with: every
 * app's admin_access.secret_env, enabled or not, plus the default. Whoever
 * sets one of these in a tenant's environment can sign tokens it accepts.
 */
export async function adminAccessSecretEnvs(): Promise<Set<string>> {
  const names = new Set([DEFAULT_SECRET_ENV]);
  for (const app of await listApps()) {
    if (app.admin_access?.secret_env) names.add(app.admin_access.secret_env);
  }
  return names;
}
