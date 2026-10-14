import jwt from 'jsonwebtoken';

// Web-UI session tokens share JWT_SECRET with the MCP OAuth tokens and the
// OAuth consent token. A distinct audience + issuer, required on verify, keeps
// those from being accepted as web sessions (and vice versa).
export const SESSION_AUDIENCE = 'overwatch-web';
export const SESSION_ISSUER = 'overwatch';
const SESSION_TTL = '24h';

export interface SessionProfile {
  name?: string;
  picture?: string;
}

export interface Session extends SessionProfile {
  email: string;
  /** Expiry as epoch seconds. */
  exp: number;
}

// Read lazily: JWT_SECRET is validated at startup, after modules are imported.
function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET env var is required');
  return s;
}

export function signSession(email: string, profile: SessionProfile = {}): string {
  const claims: Record<string, string> = { email };
  if (profile.name) claims.name = profile.name;
  if (profile.picture) claims.picture = profile.picture;
  return jwt.sign(claims, secret(), {
    algorithm: 'HS256',
    expiresIn: SESSION_TTL,
    audience: SESSION_AUDIENCE,
    issuer: SESSION_ISSUER,
  });
}

/** Verify a web session token. Throws on any failure (signature, expiry, aud, iss). */
export function verifySession(token: string): Session {
  const decoded = jwt.verify(token, secret(), {
    algorithms: ['HS256'],
    audience: SESSION_AUDIENCE,
    issuer: SESSION_ISSUER,
  }) as jwt.JwtPayload;
  if (typeof decoded.email !== 'string' || !decoded.email || typeof decoded.exp !== 'number') {
    throw new Error('Malformed session token');
  }
  return { email: decoded.email, name: decoded.name, picture: decoded.picture, exp: decoded.exp };
}
