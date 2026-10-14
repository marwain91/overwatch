import { Router, Request, Response } from 'express';
import { resolveGoogleAdmin } from '../services/identity';
import { signSession, verifySession } from '../auth/session';
import { authMiddleware, type AuthUser } from '../middleware/auth';
import { getUserRole } from '../services/users';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

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
      return res.status(403).json({ error: 'You are not authorized to access the admin panel' });
    }
    return res.status(500).json({ error: 'Google OAuth not configured' });
  }
  const { email, name, picture } = identity;

  const token = signSession(email, { name, picture });

  console.log(`Admin login successful: ${email}`);

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
router.get('/verify', authMiddleware, (req: Request, res: Response) => {
  const { email, role } = res.locals.user as AuthUser;
  // authMiddleware already validated the token; re-read it only for profile claims.
  const session = verifySession((req.headers.authorization as string).substring(7));
  res.json({
    user: {
      email,
      name: session.name,
      picture: session.picture,
      role,
    },
  });
});

// Get Google Client ID for frontend
router.get('/config', (_req: Request, res: Response) => {
  res.json({
    googleClientId: GOOGLE_CLIENT_ID,
    configured: !!GOOGLE_CLIENT_ID,
  });
});

export default router;
