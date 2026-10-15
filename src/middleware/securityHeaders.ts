import type { Request, Response, NextFunction } from 'express';

// script-src has no 'unsafe-inline': a XSS sink in our React bundle or a dep
// must not be able to execute inline. Style still needs 'unsafe-inline' for
// Tailwind's runtime style injection; styles cannot exfiltrate tokens.
// connect-src 'self' covers the UI's same-origin ws:/wss: socket.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://accounts.google.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https://*.googleusercontent.com",
  "connect-src 'self' https://accounts.google.com",
  "frame-src https://accounts.google.com",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', CSP);
  // Only over HTTPS (req.secure honours X-Forwarded-Proto from the trusted
  // proxy alone): HSTS on a plain-HTTP install would make it unreachable.
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
}
