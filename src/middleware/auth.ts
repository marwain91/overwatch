import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { isAdminEmail } from '../services/users';

// JWT_SECRET is validated at startup in index.ts
const JWT_SECRET = process.env.JWT_SECRET!;

/**
 * JWT authentication middleware
 * Verifies Bearer token in Authorization header and confirms user is still an admin.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    try {
      const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as { email: string };

      // Re-validate that user is still an admin (handles token issued before removal)
      isAdminEmail(decoded.email).then((isAdmin) => {
        if (!isAdmin) {
          console.warn(`[Auth] Rejected token for removed admin: ${decoded.email}`);
          return res.status(403).json({ error: 'Access revoked' });
        }
        return next();
      }).catch(() => {
        return res.status(500).json({ error: 'Auth check failed' });
      });
      return; // Response will be sent by the promise chain above
    } catch (error: any) {
      const reason = error.name === 'TokenExpiredError' ? 'expired' : 'invalid';
      console.warn(`[Auth] JWT ${reason}: ${error.message}`);
    }
  }

  return res.status(401).json({ error: 'Unauthorized' });
}
