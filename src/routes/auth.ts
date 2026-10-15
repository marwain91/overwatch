import { Router, Request, Response } from 'express';
import { resolveGoogleAdmin } from '../services/identity';
import { signSession, type Session } from '../auth/session';
import { revokeSession } from '../auth/sessionRevocations';
import { authMiddleware, type AuthUser } from '../middleware/auth';
import { getUserRole } from '../services/users';
import { asyncHandler } from '../utils/asyncHandler';
import { writeAuditEntry } from '../services/auditLog';

const router = Router();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

// /api/auth is not behind the audit middleware (it audits by session user).
function auditAuth(req: Request, user: string, action: string, status: number): void {
  writeAuditEntry({ user, action, method: req.method, path: req.baseUrl + req.path, status, ip: req.ip || req.socket.remoteAddress || 'unknown' });
}

// Verify Google ID token and issue JWT
router.post('/google', asyncHandler(async (req: Request, res: Response) => {
  const { credential } = req.body;

  if (!credential) {
    return res.status(400).json({ error: 'Missing credential' });
  }

  if (!GOOGLE_CLIENT_ID) {
    return res.status(500).json({ error: 'Google OAuth not configured' });
  }

  const identity = await resolveGoogleAdmin(credential);
  if (!identity.ok) {
    if (identity.reason === 'invalid_credential') throw identity.cause;
    if (identity.reason === 'invalid_payload') return res.status(401).json({ error: 'Invalid token payload' });
    if (identity.reason === 'email_not_verified') return res.status(401).json({ error: 'Email not verified' });
    if (identity.reason === 'not_admin') {
      console.log(`Unauthorized login attempt from: ${identity.email}`);
      auditAuth(req, identity.email || 'anonymous', 'login denied', 403);
      return res.status(403).json({ error: 'You are not authorized to access the admin panel' });
    }
    return res.status(500).json({ error: 'Google OAuth not configured' });
  }
  const { email, name, picture } = identity;

  const token = signSession(email, { name, picture });

  console.log(`Admin login successful: ${email}`);
  auditAuth(req, email, 'login', 200);

  res.json({
    token,
    user: {
      email,
      name,
      picture,
      role: await getUserRole(email),
    },
  });
}));

// Verify JWT token. Runs behind authMiddleware so a removed admin gets 401 and
// the response carries the caller's current role.
router.get('/verify', authMiddleware, (_req: Request, res: Response) => {
  const { email, role } = res.locals.user as AuthUser;
  // Claims authMiddleware already decoded; the token is verified once per request.
  const session = res.locals.session as Session;
  res.json({
    user: {
      email,
      name: session.name,
      picture: session.picture,
      role,
    },
  });
});

// Server-side logout: the session token is revoked until it would have
// expired. Sessions issued before tokens carried a jti cannot be revoked and
// stay valid until their expiry.
router.post('/logout', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const session = res.locals.session as Session;
  if (session.jti) await revokeSession(session.jti, session.exp);
  auditAuth(req, session.email, 'logout', 200);
  res.json({ success: true });
}));

// Get Google Client ID for frontend
router.get('/config', (_req: Request, res: Response) => {
  res.json({
    googleClientId: GOOGLE_CLIENT_ID,
    configured: !!GOOGLE_CLIENT_ID,
  });
});

export default router;
