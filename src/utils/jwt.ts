import { Request } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET!;

/** Extract the current user's email from the JWT in the Authorization header */
export function getCurrentUserEmail(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  try {
    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as { email: string };
    return decoded.email || null;
  } catch {
    return null;
  }
}
