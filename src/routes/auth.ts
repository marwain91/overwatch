import { Router, Request, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import { isAdminEmail } from '../services/users';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
// JWT_SECRET is validated at startup in index.ts
const JWT_SECRET = process.env.JWT_SECRET!;

const client = new OAuth2Client(GOOGLE_CLIENT_ID);

// Verify Google ID token and issue JWT
router.post('/google', asyncHandler(async (req: Request, res: Response) => {
  const { credential } = req.body;

  if (!credential) {
    return res.status(400).json({ error: 'Missing credential' });
  }

  if (!GOOGLE_CLIENT_ID) {
    return res.status(500).json({ error: 'Google OAuth not configured' });
  }

  const ticket = await client.verifyIdToken({
    idToken: credential,
    audience: GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();
  if (!payload || !payload.email) {
    return res.status(401).json({ error: 'Invalid token payload' });
  }

  const email = payload.email.toLowerCase();

  // Check if user is in allowed admins list
  const isAllowed = await isAdminEmail(email);
  if (!isAllowed) {
    console.log(`Unauthorized login attempt from: ${email}`);
    return res.status(403).json({ error: 'You are not authorized to access the admin panel' });
  }

  // Generate JWT for session
  const token = jwt.sign(
    {
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
    },
    JWT_SECRET,
    { expiresIn: '24h' }
  );

  console.log(`Admin login successful: ${email}`);

  res.json({
    token,
    user: {
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
    },
  });
}));

// Verify JWT token
router.get('/verify', (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as { email: string; name: string; picture: string };
    res.json({
      user: {
        email: decoded.email,
        name: decoded.name,
        picture: decoded.picture,
      },
    });
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// Get Google Client ID for frontend
router.get('/config', (req: Request, res: Response) => {
  res.json({
    googleClientId: GOOGLE_CLIENT_ID,
    configured: !!GOOGLE_CLIENT_ID,
  });
});

export default router;
