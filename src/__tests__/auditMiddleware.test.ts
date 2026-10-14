import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-audit-middleware-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
});

describe('G4 audit describeAction — records force=true tag', () => {
  it('annotates delete app with force tag when force=true', async () => {
    // We exercise the middleware directly by invoking its describeAction-producing flow.
    const { auditLog } = await import('../middleware/audit');
    const dataDir = path.join(tmpRoot, 'data');
    await fs.mkdir(dataDir, { recursive: true });

    vi.doMock('../config', () => ({ getDataDir: () => dataDir }));

    // Re-import so audit picks up the mocks
    vi.resetModules();
    const mod = await import('../middleware/audit');

    const req: any = {
      method: 'DELETE',
      baseUrl: '/api/apps',
      path: '/acme',
      query: { force: 'true' },
      body: {},
      ip: '1.2.3.4',
      socket: { remoteAddress: '1.2.3.4' },
    };
    const res: any = { statusCode: 200, json: (b: any) => b, locals: { user: { email: 'a@b.c', role: 'admin' } } };

    mod.auditLog(req, res, () => {});
    res.json({ ok: true });

    await (await import('../services/auditLog')).flushAuditLog();
    const log = await fs.readFile(path.join(dataDir, 'audit.log'), 'utf-8');
    expect(log).toContain('"action":"delete app acme (force=true)"');
    expect(log).toContain('"force":true');
    expect(log).toContain('"query"');
  });
});

describe('G8 audit queue — persists entries even with concurrent writes', () => {
  it('flushes enqueued entries in order', async () => {
    const dataDir = path.join(tmpRoot, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    vi.doMock('../config', () => ({ getDataDir: () => dataDir }));

    const { auditLog } = await import('../middleware/audit');
    const { flushAuditLog } = await import('../services/auditLog');
    const mkReq = (p: string) => ({
      method: 'DELETE', baseUrl: '/api/apps', path: `/${p}`,
      query: {}, body: {}, ip: '1.2.3.4', socket: { remoteAddress: '1.2.3.4' },
    });
    const mkRes = () => ({ statusCode: 200, json: (b: any) => b, locals: { user: { email: 'a@b.c', role: 'admin' } } });

    for (const p of ['one', 'two', 'three']) {
      const res: any = mkRes();
      auditLog(mkReq(p) as any, res, () => {});
      res.json({ ok: true });
    }
    await flushAuditLog();
    const log = await fs.readFile(path.join(dataDir, 'audit.log'), 'utf-8');
    const lines = log.trim().split('\n').map(l => JSON.parse(l));
    expect(lines.map(l => l.action)).toEqual(['delete app one', 'delete app two', 'delete app three']);
  });
});

