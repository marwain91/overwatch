import { Request, Response, NextFunction } from 'express';
import { verifySession, type Session } from '../auth/session';
import { getUserRole, AdminRole } from '../services/users';

/** Authenticated caller, set on `res.locals.user` by authMiddleware. */
export interface AuthUser {
  email: string;
  role: AdminRole;
}

/**
 * Session authentication middleware.
 * Verifies the Bearer session token, then resolves the user against admin-users
 * once per request (so tokens outlive neither admin removal nor a role change).
 * requireRole, audit and route handlers read `res.locals.user` instead of
 * re-verifying the token or re-reading the store.
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let session: Session;
  try {
    session = verifySession(authHeader.substring(7));
  } catch (error: any) {
    const reason = error.name === 'TokenExpiredError' ? 'expired' : 'invalid';
    console.warn(`[Auth] JWT ${reason}: ${error.message}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const email = session.email;
  try {
    const role = await getUserRole(email);
    if (!role) {
      // Fail closed: valid signature, but no longer an admin user.
      console.warn(`[Auth] Rejected token for removed admin: ${email}`);
      return res.status(401).json({ error: 'Unauthorized' });
    }
    res.locals.user = { email, role } satisfies AuthUser;
    // Decoded claims (name, picture) for handlers that need them, e.g. /auth/verify.
    res.locals.session = session;
    return next();
  } catch (err: any) {
    console.error(`[Auth] Auth check failed: ${err?.message || err}`);
    return res.status(500).json({ error: 'Auth check failed' });
  }
}
