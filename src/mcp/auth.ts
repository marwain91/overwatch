import { verifyAccessToken } from '../oauth/tokens';
import { isAdminEmail, getUserRole, normaliseRole, AdminRole } from '../services/users';

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
      // Revocation safety: token may have been minted before removal.
      if (!(await isAdminEmail(decoded.email))) {
        throw new Error('Access revoked');
      }
      const role = normaliseRole(await getUserRole(decoded.email));
      return {
        token,
        clientId: decoded.email,
        scopes: decoded.scope ? decoded.scope.split(' ') : [],
        extra: { email: decoded.email, role },
      };
    },
  };
}
