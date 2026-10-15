import { describe, it, expect } from 'vitest';
import express, { Router } from 'express';
import request from 'supertest';
import * as fs from 'fs/promises';
import * as path from 'path';
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
  // Mounted the way index.ts mounts the real routers (routes/backups.ts, routes/database.ts).
  function appWith() {
    const limiter = destructiveRateLimit({ windowMs: 60_000, maxRequests: 1 });
    const ok = (_req: express.Request, res: express.Response) => { res.json({ ok: true }); };
    const backups = Router({ mergeParams: true });
    backups.post('/', ok);
    backups.post('/:snapshotId/restore', ok);
    backups.post('/:snapshotId/create-tenant', ok);
    backups.post('/prune', ok);
    const tenants = Router({ mergeParams: true });
    tenants.post('/:tenantId/restart', ok);
    const database = Router();
    database.post('/processes/:id/kill', ok);
    const app = express();
    app.use(express.json());
    app.use('/api/apps/:appId/tenants', limiter, tenants);
    app.use('/api/apps/:appId/backups', limiter, backups);
    app.use('/api/database', limiter, database);
    return app;
  }
  const statuses = async (url: string, n: number) => {
    const app = appWith();
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push((await request(app).post(url).send({})).status);
    return out;
  };

  it.each([
    '/api/apps/app1/backups/abc123/restore',
    '/api/apps/app1/backups/prune',
    '/api/database/processes/42/kill',
    // Express routes case-insensitively and ignores one trailing slash.
    '/API/APPS/app1/BACKUPS/abc123/RESTORE',
    '/api/apps/app1/Backups/Prune',
    '/api/DATABASE/processes/42/Kill',
    '/api/apps/app1/backups/abc123/restore/',
    '/api/apps/app1/backups/prune/',
    '/api/database/processes/42/kill/',
    // Percent-encoding inside a parameter still routes to the handler.
    '/api/apps/app1/backups/ab%63/restore',
    '/api/apps/app1/backups/prune?dry=1',
  ])('limits POST %s', async (url) => {
    expect(await statuses(url, 2)).toEqual([200, 429]);
  });

  it.each([
    '/api/apps/app1/backups//prune',
    '/api/apps/app1//backups/prune',
    '/api/database//processes/42/kill',
    '/api/apps/app1/backups/%70rune',
    '/api/apps/app1/backups/abc123/%72estore',
    '/api/database/processes/42/%6Bill',
  ])('POST %s never reaches a handler', async (url) => {
    expect(await statuses(url, 2)).toEqual([404, 404]);
  });

  it.each([
    '/api/apps/app1/backups',
    '/api/apps/app1/backups/abc123/create-tenant',
    '/api/apps/app1/tenants/t1/restart',
  ])('does not count POST %s', async (url) => {
    expect(await statuses(url, 3)).toEqual([200, 200, 200]);
  });

  it('the classified routes still exist in the route files', async () => {
    const read = (f: string) => fs.readFile(path.join(__dirname, '..', 'routes', f), 'utf-8');
    const backups = await read('backups.ts');
    expect(backups).toContain("router.post('/:snapshotId/restore'");
    expect(backups).toContain("router.post('/prune'");
    expect(await read('database.ts')).toContain("router.post('/processes/:id/kill'");
  });
});
