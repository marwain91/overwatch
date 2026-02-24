import { Router, Request, Response } from 'express';
import { listAdminUsers, addAdminUser, removeAdminUser } from '../services/users';
import { asyncHandler } from '../utils/asyncHandler';
import { getCurrentUserEmail } from '../utils/jwt';
import { isValidEmail } from '../utils/validators';

const router = Router();

// List all admin users
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const users = await listAdminUsers();
  res.json(users);
}));

// Add a new admin user
router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const { email } = req.body;

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

  const user = await addAdminUser(email, currentUser);
  res.status(201).json(user);
}));

// Remove an admin user
router.delete('/:email', asyncHandler(async (req: Request, res: Response) => {
  const email = decodeURIComponent(req.params.email).trim().toLowerCase();

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
