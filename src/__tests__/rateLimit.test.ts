import { describe, it, expect } from 'vitest';
import { destructiveRateLimit } from '../middleware/rateLimit';

describe('G3 destructiveRateLimit — only gates destructive requests', () => {
  const makeReq = (method: string, query: any = {}, body: any = {}) => ({ method, query, body, ip: '1.2.3.4', socket: { remoteAddress: '1.2.3.4' } }) as any;
  const makeRes = () => {
    const res: any = { statusCode: 200, headers: {} };
    res.status = (s: number) => { res.statusCode = s; return res; };
    res.set = (k: string, v: string) => { res.headers[k] = v; return res; };
    res.json = (b: any) => { res.body = b; return res; };
    return res;
  };

  it('passes GET through without consuming quota', () => {
    const mw = destructiveRateLimit({ windowMs: 1_000, maxRequests: 1 });
    const calls: number[] = [];
    for (let i = 0; i < 10; i++) mw(makeReq('GET'), makeRes(), () => calls.push(i));
    expect(calls).toHaveLength(10);
  });

  it('rate-limits DELETE after quota exceeded', () => {
    const mw = destructiveRateLimit({ windowMs: 1_000, maxRequests: 2 });
    let allowed = 0;
    let denied = 0;
    for (let i = 0; i < 5; i++) {
      const res = makeRes();
      mw(makeReq('DELETE'), res, () => { allowed++; });
      if (res.statusCode === 429) denied++;
    }
    expect(allowed).toBe(2);
    expect(denied).toBe(3);
  });

  it('rate-limits POST with ?force=true', () => {
    const mw = destructiveRateLimit({ windowMs: 1_000, maxRequests: 1 });
    let allowed = 0;
    let denied = 0;
    for (let i = 0; i < 3; i++) {
      const res = makeRes();
      mw(makeReq('POST', { force: 'true' }), res, () => { allowed++; });
      if (res.statusCode === 429) denied++;
    }
    expect(allowed).toBe(1);
    expect(denied).toBe(2);
  });
});

describe('destructiveRateLimit — restore, prune and process kill count as destructive', () => {
  const req = (method: string, baseUrl: string, path: string) =>
    ({ method, baseUrl, path, query: {}, body: {}, ip: '1.2.3.4', socket: { remoteAddress: '1.2.3.4' } }) as any;
  const res = () => {
    const r: any = { statusCode: 200 };
    r.status = (s: number) => { r.statusCode = s; return r; };
    r.set = () => r;
    r.json = () => r;
    return r;
  };
  const allowedOf = (make: () => any, n = 3) => {
    const mw = destructiveRateLimit({ windowMs: 1_000, maxRequests: 1 });
    let allowed = 0;
    for (let i = 0; i < n; i++) mw(make(), res(), () => { allowed++; });
    return allowed;
  };

  it.each([
    ['backup restore', '/api/apps/app1/backups', '/abc123/restore'],
    ['backup prune', '/api/apps/app1/backups', '/prune'],
    ['database process kill', '/api/database', '/processes/42/kill'],
  ])('limits %s', (_label, baseUrl, path) => {
    expect(allowedOf(() => req('POST', baseUrl, path))).toBe(1);
  });

  it.each([
    ['backup create', '/api/apps/app1/backups', '/'],
    ['clone backup to a new tenant', '/api/apps/app1/backups', '/abc123/create-tenant'],
    ['a tenant restart', '/api/apps/app1/tenants', '/t1/restart'],
    ['a GET of the processes list', '/api/database', '/processes'],
  ])('does not count %s', (_label, baseUrl, path) => {
    expect(allowedOf(() => req('POST', baseUrl, path))).toBe(3);
  });
});
