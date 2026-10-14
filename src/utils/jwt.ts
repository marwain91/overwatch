import { Request } from 'express';
import type { AuthUser } from '../middleware/auth';

/**
 * The current user's email, as resolved by authMiddleware (`res.locals.user`).
 * Returns null on routes that did not run authMiddleware.
 */
export function getCurrentUserEmail(req: Request): string | null {
  const user = req.res?.locals?.user as AuthUser | undefined;
  return user?.email || null;
}
