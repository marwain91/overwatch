import { OAuth2Client, TokenPayload } from 'google-auth-library';
import { isAdminEmail } from './users';

export type GoogleAdminResult =
  | { ok: true; email: string; name?: string; picture?: string }
  | { ok: false; reason: 'not_configured' | 'invalid_credential' | 'email_not_verified' | 'invalid_payload' | 'not_admin'; email?: string; cause?: unknown };

let cached: { clientId: string; client: OAuth2Client } | null = null;

function clientFor(clientId: string): OAuth2Client {
  if (!cached || cached.clientId !== clientId) cached = { clientId, client: new OAuth2Client(clientId) };
  return cached.client;
}

/**
 * Google ID-token credential -> admin user. The one place that verifies the
 * credential and checks admin membership; callers map `reason` to their own
 * response contract. GOOGLE_CLIENT_ID is read per call so config changes and
 * test setup apply.
 */
export async function resolveGoogleAdmin(credential: string): Promise<GoogleAdminResult> {
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  if (!clientId) return { ok: false, reason: 'not_configured' };

  let payload: TokenPayload | undefined;
  try {
    const ticket = await clientFor(clientId).verifyIdToken({ idToken: credential, audience: clientId });
    payload = ticket.getPayload();
  } catch (cause) {
    return { ok: false, reason: 'invalid_credential', cause };
  }
  if (!payload || !payload.email) return { ok: false, reason: 'invalid_payload' };
  if (!payload.email_verified) return { ok: false, reason: 'email_not_verified' };

  const email = payload.email.toLowerCase();
  if (!(await isAdminEmail(email))) return { ok: false, reason: 'not_admin', email };
  return { ok: true, email, name: payload.name, picture: payload.picture };
}
