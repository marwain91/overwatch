import { Router, Request, Response, NextFunction } from 'express';

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

// POSTs that overwrite or discard data, or kill work in flight, without being
// a DELETE (full paths as mounted in index.ts; the handlers live in
// routes/backups.ts and routes/database.ts). They are matched by an Express
// router so classification follows the same rules that pick the handler
// (case-insensitive, optional trailing slash, raw path): a hand-written
// pattern that disagreed with routing would let a request skip the limiter.
const DESTRUCTIVE_POST_ROUTES = [
  '/api/apps/:appId/backups/:snapshotId/restore',
  '/api/apps/:appId/backups/prune',
  '/api/database/processes/:id/kill',
];

interface RouteProbe { method: string; url: string; onMatch: () => void }

const destructivePosts = Router();
destructivePosts.post(DESTRUCTIVE_POST_ROUTES, (req: Request) => {
  (req as unknown as RouteProbe).onMatch();
});

/** DELETE, or a force flag in the query or body. */
function isForcedOrDelete(req: Request): boolean {
  return req.method === 'DELETE' ||
    req.query?.force === 'true' ||
    (req.body && typeof req.body === 'object' && req.body.force === true);
}

/** Calls back with whether the request is one of the destructive POST routes. */
export function matchDestructivePost(req: Request, cb: (destructive: boolean) => void): void {
  if (req.method !== 'POST') return cb(false);
  // A probe, not the live request: routing mutates url/baseUrl/params.
  const probe: RouteProbe = { method: 'POST', url: req.originalUrl || req.url, onMatch: () => cb(true) };
  // No match (or a path the real router would also reject) ends here.
  destructivePosts(probe as unknown as Request, {} as Response, () => cb(false));
}

/**
 * Apply a tighter rate limiter only to destructive requests: DELETE, force, and
 * the POST routes above (backup restore and prune, DB process kill). Other
 * requests pass through without consuming from the destructive quota.
 */
export function destructiveRateLimit(options: RateLimitOptions) {
  const limiter = rateLimit(options);
  return (req: Request, res: Response, next: NextFunction) => {
    if (isForcedOrDelete(req)) return limiter(req, res, next);
    matchDestructivePost(req, destructive => (destructive ? limiter(req, res, next) : next()));
  };
}
