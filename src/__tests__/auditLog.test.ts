import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-audit-service-'));
  vi.doMock('../config', () => ({ getDataDir: () => dataDir }));
});

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock('../config');
  await fs.rm(dataDir, { recursive: true, force: true });
});

const base = { user: 'a@example.test', method: 'POST', path: '/api/x', status: 200, ip: '1.1.1.1' };

describe('auditLog service', () => {
  it('appends in order, redacts secrets and writes the file 0600', async () => {
    const svc = await import('../services/auditLog');
    svc.writeAuditEntry({ ...base, action: 'one', body: { password: 'hunter2', name: 'n' } });
    svc.writeAuditEntry({ ...base, action: 'two' });
    await svc.flushAuditLog();
    const file = path.join(dataDir, 'audit.log');
    const lines = (await fs.readFile(file, 'utf-8')).trim().split('\n').map(l => JSON.parse(l));
    expect(lines.map(l => l.action)).toEqual(['one', 'two']);
    expect(lines[0].body).toEqual({ password: '[redacted]', name: 'n' });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it('reads newest first, filters, and strips bodies', async () => {
    const svc = await import('../services/auditLog');
    svc.writeAuditEntry({ ...base, user: 'alice@example.test', action: 'create tenant a', body: { x: 1 } });
    svc.writeAuditEntry({ ...base, user: 'bob@example.test', action: 'create tenant b' });
    svc.writeAuditEntry({ ...base, user: 'alice@example.test', action: 'delete tenant a' });
    await svc.flushAuditLog();
    const all = await svc.readAuditEntries({ limit: 2 });
    expect(all.map(e => e.action)).toEqual(['delete tenant a', 'create tenant b']);
    const alice = await svc.readAuditEntries({ limit: 10, user: 'ALICE' });
    expect(alice.map(e => e.action)).toEqual(['delete tenant a', 'create tenant a']);
    expect(alice.every(e => !('body' in e))).toBe(true);
    expect(await svc.readAuditEntries({ limit: 10, action: 'nope' })).toEqual([]);
  });

  it('returns no entries when the log does not exist yet', async () => {
    const svc = await import('../services/auditLog');
    expect(await svc.readAuditEntries({ limit: 5 })).toEqual([]);
  });

  it('prune keeps the newest entries and never drops appends racing it', async () => {
    const svc = await import('../services/auditLog');
    for (let i = 0; i < 6; i++) svc.writeAuditEntry({ ...base, action: `old ${i}` });
    await svc.flushAuditLog();
    const pruning = svc.pruneAuditLog(5);
    for (let i = 0; i < 3; i++) svc.writeAuditEntry({ ...base, action: `new ${i}` });
    expect(await pruning).toBe(4);
    await svc.flushAuditLog();
    const lines = (await fs.readFile(path.join(dataDir, 'audit.log'), 'utf-8')).trim().split('\n').map(l => JSON.parse(l));
    expect(lines.map(l => l.action)).toEqual(['old 4', 'old 5', 'new 0', 'new 1', 'new 2']);
    expect((await fs.stat(path.join(dataDir, 'audit.log'))).mode & 0o777).toBe(0o600);
  });
});

describe('audit middleware', () => {
  async function describeRequest(method: string, baseUrl: string, p: string, body: any = {}) {
    const mod = await import('../middleware/audit');
    const svc = await import('../services/auditLog');
    const req: any = { method, baseUrl, path: p, query: {}, body, ip: '1.2.3.4', socket: { remoteAddress: '1.2.3.4' } };
    const res: any = { statusCode: 200, json: (b: any) => b, locals: { user: { email: 'root@example.test', role: 'admin' } } };
    mod.auditLog(req, res, () => {});
    res.json({ ok: true });
    await svc.flushAuditLog();
    const lines = (await fs.readFile(path.join(dataDir, 'audit.log'), 'utf-8')).trim().split('\n');
    return JSON.parse(lines[lines.length - 1]);
  }

  it('labels an admin role change with the email and the new role', async () => {
    const entry = await describeRequest('PATCH', '/api/admin-users', '/bob%40example.test', { role: 'editor' });
    expect(entry.action).toBe('change role of bob@example.test to editor');
    expect(entry.user).toBe('root@example.test');
  });

  it('does not export the writer any more (CLI/MCP use the service)', async () => {
    const mod: any = await import('../middleware/audit');
    expect(mod.writeAuditEntry).toBeUndefined();
    expect(mod.flushAuditLog).toBeUndefined();
  });
});
