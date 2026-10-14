import { Request, Response, NextFunction } from 'express';
import { can, AdminRole } from '../services/users';
import type { AuthUser } from './auth';

/**
 * Gate a route by role. Usage:
 *   router.delete(..., requireRole('admin'), asyncHandler(...))
 *
 * Role hierarchy: admin > editor > viewer.
 * - viewer: read-only (GET)
 * - editor: mutations except destructive ops
 * - admin: everything, including delete / force / purge
 *
 * Users without a `role` field in admin-users.json are treated as 'admin' for
 * backward compatibility with installs created before RBAC landed.
 */
export function requireRole(min: AdminRole) {
  return (_req: Request, res: Response, next: NextFunction) => {
    // authMiddleware already verified the session and resolved the role.
    const user = res.locals.user as AuthUser | undefined;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!can(user.role, min)) {
      return res.status(403).json({ error: `This action requires '${min}' role; yours is '${user.role}'.` });
    }
    next();
  };
}
