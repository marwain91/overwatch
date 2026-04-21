import { Request, Response, NextFunction } from 'express';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  message?: string;
}

export function rateLimit(options: RateLimitOptions) {
  const { windowMs, maxRequests, message = 'Too many requests, please try again later' } = options;
  const store = new Map<string, RateLimitEntry>();

  // Clean up expired entries every minute
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now > entry.resetAt) {
        store.delete(key);
      }
    }
  }, 60_000).unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = store.get(key);

    if (!entry || now > entry.resetAt) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    entry.count++;
    if (entry.count > maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: message });
    }

    next();
  };
}

/**
 * Apply a tighter rate limiter only when the request is destructive (DELETE or ?force=true).
 * Non-destructive requests pass through without consuming from the destructive quota.
 */
export function destructiveRateLimit(options: RateLimitOptions) {
  const limiter = rateLimit(options);
  return (req: Request, res: Response, next: NextFunction) => {
    const isDestructive =
      req.method === 'DELETE' ||
      req.query?.force === 'true' ||
      (req.body && typeof req.body === 'object' && req.body.force === true);
    if (!isDestructive) return next();
    return limiter(req, res, next);
  };
}
