import { Router, Request, Response } from 'express';
import { listAdminUsers, addAdminUser, removeAdminUser, setAdminUserRole, normaliseRole } from '../services/users';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { getCurrentUserEmail } from '../utils/jwt';
import { isValidEmail } from '../utils/validators';
import { requireRole } from '../middleware/requireRole';
import { requireConfirmId } from '../middleware/confirmDestructive';

const router = Router();

const RoleSchema = z.enum(['viewer', 'editor', 'admin']);

// List all admin users
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const users = await listAdminUsers();
  // Legacy records without a stored role are effectively admin; report that.
  res.json(users.map(u => ({ ...u, role: normaliseRole(u.role) })));
}));

// Add a new admin user — admin role required
router.post('/', requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
  const { email } = req.body;
  const parsedRole = req.body.role === undefined ? undefined : RoleSchema.safeParse(req.body.role);
  if (parsedRole && !parsedRole.success) {
    return res.status(400).json({ error: 'Invalid role. Must be one of: viewer, editor, admin' });
  }

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Email is required' });
  }

  const trimmed = email.trim().toLowerCase();
  if (!isValidEmail(trimmed)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  const currentUser = getCurrentUserEmail(req);
  if (!currentUser) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const user = await addAdminUser(email, currentUser, parsedRole?.data);
  res.status(201).json(user);
}));

// Change an admin user's role — admin role required
router.patch('/:email', requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
  const email = decodeURIComponent((req.params as Record<string, string>).email).trim().toLowerCase();
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  const parsedRole = RoleSchema.safeParse(req.body?.role);
  if (!parsedRole.success) {
    return res.status(400).json({ error: 'Invalid role. Must be one of: viewer, editor, admin' });
  }

  const currentUser = getCurrentUserEmail(req);
  if (!currentUser) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const user = await setAdminUserRole(email, parsedRole.data, currentUser);
  res.json({ ...user, role: normaliseRole(user.role) });
}));

// Remove an admin user — admin role + typed email confirmation required
router.delete('/:email', requireRole('admin'), requireConfirmId('email'), asyncHandler(async (req: Request, res: Response) => {
  const email = decodeURIComponent((req.params as Record<string, string>).email).trim().toLowerCase();

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  const currentUser = getCurrentUserEmail(req);
  if (!currentUser) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  await removeAdminUser(email, currentUser);
  res.json({ success: true });
}));

export default router;
