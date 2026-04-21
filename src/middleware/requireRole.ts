import { Request, Response, NextFunction } from 'express';
import { getCurrentUserEmail } from '../utils/jwt';
import { getUserRole, can, AdminRole } from '../services/users';

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
  return async (req: Request, res: Response, next: NextFunction) => {
    const email = getCurrentUserEmail(req);
    if (!email) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const role = await getUserRole(email);
      if (!role) {
        return res.status(403).json({ error: 'Access revoked' });
      }
      if (!can(role, min)) {
        return res.status(403).json({ error: `This action requires '${min}' role; yours is '${role}'.` });
      }
      next();
    } catch (err: any) {
      console.error(`[requireRole] ${err?.message || err}`);
      return res.status(500).json({ error: 'Role check failed' });
    }
  };
}
