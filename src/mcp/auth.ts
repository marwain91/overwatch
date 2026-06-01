import { verifyAccessToken } from '../oauth/tokens';
import { listAdminUsers, normaliseRole, AdminRole } from '../services/users';

export interface McpAuthExtra {
  email: string;
  role: AdminRole;
}

export interface McpAuthInfo {
  token: string;
  clientId: string;
  scopes: string[];
  extra: McpAuthExtra;
}

// Implements the OAuthTokenVerifier contract consumed by requireBearerAuth:
// an object with async verifyAccessToken(token) -> AuthInfo (throws on invalid).
export function createTokenVerifier(opts: { issuer: string }) {
  return {
    async verifyAccessToken(token: string): Promise<McpAuthInfo> {
      const decoded = verifyAccessToken(token, { issuer: opts.issuer });
      // Single consistent snapshot: derive both membership and role from one read,
      // closing the TOCTOU window where a removal between two reads could resolve
      // a removed user to the back-compat 'admin' default.
      const users = await listAdminUsers();
      const match = users.find(u => u.email.toLowerCase() === decoded.email.toLowerCase());
      if (!match) throw new Error('Access revoked'); // not (or no longer) an admin
      // Legacy records without an explicit role resolve to 'admin' per the
      // documented back-compat contract in services/users.ts.
      const role = normaliseRole(match.role);
      return {
        token,
        clientId: decoded.email,
        scopes: decoded.scope ? decoded.scope.split(' ') : [],
        extra: { email: decoded.email, role },
      };
    },
  };
}
