import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// JWT_SECRET is validated at startup in index.ts
const JWT_SECRET = process.env.JWT_SECRET!;

/**
 * JWT authentication middleware
 * Verifies Bearer token in Authorization header
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    try {
      jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
      return next();
    } catch (error) {
      // Token invalid
    }
  }

  return res.status(401).json({ error: 'Unauthorized' });
}
