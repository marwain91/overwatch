import { describe, it, expect } from 'vitest';
import { requireConfirmId } from '../middleware/confirmDestructive';

describe('R3 requireConfirmId middleware', () => {
  const mkReq = (params: any, headers: Record<string, string> = {}, body: any = {}) => ({
    params,
    body,
    header: (name: string) => headers[name],
  }) as any;

  const mkRes = () => {
    const res: any = { statusCode: 200, body: undefined };
    res.status = (s: number) => { res.statusCode = s; return res; };
    res.json = (b: any) => { res.body = b; return res; };
    return res;
  };

  it('rejects with 400 when header is missing', () => {
    const mw = requireConfirmId('appId');
    const res = mkRes();
    mw(mkReq({ appId: 'acme' }), res, () => { throw new Error('should not call next'); });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/X-Confirm-Id/);
  });

  it('rejects with 400 when header does not match', () => {
    const mw = requireConfirmId('appId');
    const res = mkRes();
    mw(mkReq({ appId: 'acme' }, { 'X-Confirm-Id': 'gadgets' }), res, () => { throw new Error('should not call next'); });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/mismatch/);
  });

  it('passes when X-Confirm-Id header matches the param', () => {
    const mw = requireConfirmId('appId');
    const res = mkRes();
    let called = false;
    mw(mkReq({ appId: 'acme' }, { 'X-Confirm-Id': 'acme' }), res, () => { called = true; });
    expect(called).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it('accepts confirmId in body for POST-style handlers', () => {
    const mw = requireConfirmId('appId');
    const res = mkRes();
    let called = false;
    mw(mkReq({ appId: 'acme' }, {}, { confirmId: 'acme' }), res, () => { called = true; });
    expect(called).toBe(true);
  });
});


