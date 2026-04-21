import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { destructiveRateLimit } from '../middleware/rateLimit';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-sprint1-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
});

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

describe('G1 readApps — refuses to silently accept corrupt JSON', () => {
  it('throws a clear error when apps.json is malformed', async () => {
    const dataDir = path.join(tmpRoot, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'apps.json'), '{not valid json');

    vi.doMock('../config', () => ({ getDataDir: () => dataDir, getAppsDir: () => path.join(tmpRoot, 'apps') }));
    vi.doMock('./fileLock', () => ({ withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn() }));

    const { listApps } = await import('../services/app');
    await expect(listApps()).rejects.toThrow(/not valid JSON/);
  });

  it('throws when apps.json has an invalid app entry (schema drift)', async () => {
    const dataDir = path.join(tmpRoot, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    // Missing required `name`, `domain_template`, `registry`, `services`…
    await fs.writeFile(path.join(dataDir, 'apps.json'), JSON.stringify([{ id: 'incomplete' }]));

    vi.doMock('../config', () => ({ getDataDir: () => dataDir, getAppsDir: () => path.join(tmpRoot, 'apps') }));
    vi.doMock('./fileLock', () => ({ withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn() }));

    const { listApps } = await import('../services/app');
    await expect(listApps()).rejects.toThrow(/failed validation/);
  });
});

describe('G4 audit describeAction — records force=true tag', () => {
  it('annotates delete app with force tag when force=true', async () => {
    // We exercise the middleware directly by invoking its describeAction-producing flow.
    const { auditLog } = await import('../middleware/audit');
    const dataDir = path.join(tmpRoot, 'data');
    await fs.mkdir(dataDir, { recursive: true });

    vi.doMock('../config', () => ({ getDataDir: () => dataDir }));
    vi.doMock('../utils/jwt', () => ({ getCurrentUserEmail: () => 'a@b.c' }));

    // Re-import so audit picks up the mocks
    vi.resetModules();
    const mod = await import('../middleware/audit');

    const req: any = {
      method: 'DELETE',
      baseUrl: '/api/apps',
      path: '/kwoutr',
      query: { force: 'true' },
      body: {},
      ip: '1.2.3.4',
      socket: { remoteAddress: '1.2.3.4' },
    };
    const res: any = { statusCode: 200, json: (b: any) => b };

    mod.auditLog(req, res, () => {});
    res.json({ ok: true });

    // Give the fire-and-forget appendFile a tick
    await new Promise(r => setTimeout(r, 50));
    const log = await fs.readFile(path.join(dataDir, 'audit.log'), 'utf-8');
    expect(log).toContain('"action":"delete app kwoutr (force=true)"');
    expect(log).toContain('"force":true');
    expect(log).toContain('"query"');
  });
});
