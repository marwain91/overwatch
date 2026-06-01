import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';
import { AdminRole } from '../services/users';

// The MCP resource identifier is the issuer's /mcp endpoint. Tokens are scoped
// to this audience so they can't be replayed against the 24h web-UI session.
export function mcpResourceUrl(issuer: string): string {
  return new URL('/mcp', issuer).toString();
}

interface AccessClaims {
  sub: string;
  role: AdminRole;
  scope: string;
  iss: string;
  aud: string;
}

export function issueAccessToken(opts: { email: string; role: AdminRole; issuer: string; ttl: string }): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET env var is required');
  const claims: Omit<AccessClaims, 'iss' | 'aud'> = {
    sub: opts.email,
    role: opts.role,
    scope: 'tenants',
  };
  const signOpts: jwt.SignOptions = {
    algorithm: 'HS256',
    expiresIn: opts.ttl as jwt.SignOptions['expiresIn'],
    issuer: opts.issuer,
    audience: mcpResourceUrl(opts.issuer),
  };
  return jwt.sign(claims, secret, signOpts);
}

export interface VerifiedToken {
  email: string;
  role: AdminRole;
  aud: string;
  scope: string;
  exp: number;
}

export function verifyAccessToken(token: string, opts: { issuer: string }): VerifiedToken {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET env var is required');
  const decoded = jwt.verify(token, secret, {
    algorithms: ['HS256'],
    issuer: opts.issuer,
    audience: mcpResourceUrl(opts.issuer),
  }) as jwt.JwtPayload & { role: AdminRole; scope: string };
  return {
    email: String(decoded.sub),
    role: decoded.role,
    aud: Array.isArray(decoded.aud) ? decoded.aud[0] : String(decoded.aud),
    scope: decoded.scope,
    exp: Number(decoded.exp),
  };
}

export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}
