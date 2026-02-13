import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { listAdminUsers, addAdminUser, removeAdminUser } from '../services/users';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

// JWT_SECRET is validated at startup in index.ts
const JWT_SECRET = process.env.JWT_SECRET!;

// Helper to get current user email from token
function getCurrentUserEmail(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  try {
    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, JWT_SECRET) as { email: string };
    return decoded.email;
  } catch {
    return null;
  }
}

// List all admin users
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const users = await listAdminUsers();
  res.json(users);
}));

// Add a new admin user
router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
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
  const { email } = req.params;

  const currentUser = getCurrentUserEmail(req);
  if (!currentUser) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  await removeAdminUser(email, currentUser);
  res.json({ success: true });
}));

export default router;
