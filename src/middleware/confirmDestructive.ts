import { Request, Response, NextFunction } from 'express';

/**
 * Guard for destructive endpoints: require the client to echo back the resource
 * identifier in the `X-Confirm-Id` header (or `confirmId` body field for POST).
 *
 * Mitigates accidental destruction from double-click, stale tabs, or replayed
 * cURL without the operator realising which id was in scope.
 *
 * The expected id is derived from req.params via `paramKey` (default 'appId').
 */
export function requireConfirmId(paramKey: string = 'appId') {
  return (req: Request, res: Response, next: NextFunction) => {
    const expected = req.params[paramKey];
    if (!expected) {
      return res.status(400).json({ error: `Missing :${paramKey} in route` });
    }
    const header = req.header('X-Confirm-Id');
    const bodyVal = req.body && typeof req.body === 'object' ? (req.body as any).confirmId : undefined;
    const provided = header || bodyVal;
    if (!provided) {
      return res.status(400).json({
        error: `Destructive operation requires X-Confirm-Id header (or confirmId body field) matching '${expected}'.`,
      });
    }
    if (provided !== expected) {
      return res.status(400).json({
        error: `X-Confirm-Id mismatch: expected '${expected}', got '${provided}'.`,
      });
    }
    next();
  };
}
