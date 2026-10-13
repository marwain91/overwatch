import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../utils/httpErrors';

/**
 * Global error handler. The full error is always logged server-side. For
 * status >= 500 the client only sees a generic message unless the error is an
 * HttpError that opted in with `expose: true`, so filesystem paths and driver
 * messages from unexpected failures never leak.
 */
export function errorHandler(err: any, req: Request, res: Response, next: NextFunction): void {
  console.error(`Error in ${req.method} ${req.path}:`, err);
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof ZodError) {
    // Schema parse failures are caller input problems, not server faults.
    const detail = err.errors.map(e => `${e.path.join('.') || 'value'}: ${e.message}`).join(', ');
    res.status(400).json({ error: `Invalid input: ${detail}` });
    return;
  }
  const rawStatus = err instanceof HttpError ? err.status : (err?.status || err?.statusCode);
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;
  if (status >= 500) {
    const exposed = err instanceof HttpError && err.expose;
    res.status(status).json({ error: exposed ? err.message : 'Internal server error' });
    return;
  }
  res.status(status).json({ error: err?.message || 'Bad request' });
}
