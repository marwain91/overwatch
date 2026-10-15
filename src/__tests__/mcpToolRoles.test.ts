import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

let tmpDir: string;
vi.mock('../config', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, getDataDir: () => tmpDir };
});
const { startTenant, stopTenant, restartTenant, listTenants, getTenantInfo, updateTenant, writeAuditEntry, users } = vi.hoisted(() => ({
  startTenant: vi.fn(async () => {}),
  stopTenant: vi.fn(async () => {}),
  restartTenant: vi.fn(async () => {}),
  listTenants: vi.fn(async () => []),
  getTenantInfo: vi.fn(async () => null),
  updateTenant: vi.fn(async () => {}),
  writeAuditEntry: vi.fn(),
  users: [] as { email: string; role: string; addedAt: string; addedBy: string }[],
}));
vi.mock('../services/docker', () => ({ startTenant, stopTenant, restartTenant, listTenants, getTenantInfo }));
vi.mock('../services/tenant', () => ({ updateTenant, validateImageTag: () => ({ valid: true }) }));
vi.mock('../services/app', () => ({ listApps: vi.fn(async () => []) }));
vi.mock('../services/auditLog', () => ({ writeAuditEntry: (e: unknown) => writeAuditEntry(e) }));
vi.mock('../services/users', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, listAdminUsers: vi.fn(async () => users) };
});

import { MCP_TOOLS, guardedTool, mountMcp } from '../mcp/server';
import { issueAccessToken } from '../oauth/tokens';

const ISSUER = 'https://ow.example.com';
const as = (role: 'viewer' | 'editor' | 'admin') => ({ authInfo: { extra: { email: `${role}@b.c`, role } } });
const spec = (name: string) => MCP_TOOLS.find(t => t.name === name)!;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-mcproles-'));
  process.env.JWT_SECRET = 'x'.repeat(40);
  process.env.GOOGLE_CLIENT_ID = 'cid';
  writeAuditEntry.mockReset();
  for (const f of [startTenant, stopTenant, restartTenant, updateTenant]) f.mockClear();
});

describe('MCP tools declare their role centrally', () => {
  it('every tool has a minimum role, matching docs/mcp.md', () => {
    const roles = Object.fromEntries(MCP_TOOLS.map(t => [t.name, t.minRole]));
    expect(roles).toEqual({
      list_apps: 'viewer', list_tenants: 'viewer', get_tenant: 'viewer',
      start_tenant: 'editor', stop_tenant: 'editor', restart_tenant: 'editor', update_tenant: 'editor',
    });
  });

  it.each(['start_tenant', 'stop_tenant', 'restart_tenant', 'update_tenant'])(
    'refuses a viewer %s before the handler runs, and audits the denial', async (name) => {
      const args = { appId: 'app1', tenantId: 't1', imageTag: 'v2' };
      const r = await guardedTool(spec(name))(args, as('viewer'));
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toBe("This action requires 'editor' role; yours is 'viewer'.");
      for (const f of [startTenant, stopTenant, restartTenant, updateTenant]) expect(f).not.toHaveBeenCalled();
      expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
        user: 'viewer@b.c', method: 'MCP', path: `/mcp/${name}`, status: 403,
      }));
    });

  it('lets an editor through to the handler', async () => {
    const r = await guardedTool(spec('stop_tenant'))({ appId: 'app1', tenantId: 't1' }, as('editor'));
    expect(r.isError).toBeFalsy();
    expect(stopTenant).toHaveBeenCalledWith('app1', 't1');
  });

  it('lets a viewer read', async () => {
    const r = await guardedTool(spec('list_tenants'))({}, as('viewer'));
    expect(r.isError).toBeFalsy();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('fails a call without auth context', async () => {
    await expect(guardedTool(spec('list_apps'))({}, {})).rejects.toThrow('missing auth context');
  });

  it('applies the gate to a real tools/call over /mcp', async () => {
    users.splice(0, users.length, { email: 'v@b.c', role: 'viewer', addedAt: '2020-01-01T00:00:00.000Z', addedBy: 'x' });
    const app = express();
    app.use(express.json());
    mountMcp(app, { issuer: ISSUER, accessTokenTtl: '1h', refreshTokenTtl: '30d' });
    const token = issueAccessToken({ email: 'v@b.c', role: 'viewer', issuer: ISSUER, ttl: '1h' });
    const res = await request(app).post('/mcp')
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'stop_tenant', arguments: { appId: 'app1', tenantId: 't1' } } });
    expect(res.status).toBe(200);
    expect(res.text).toContain("requires 'editor' role");
    expect(stopTenant).not.toHaveBeenCalled();
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ user: 'v@b.c', path: '/mcp/stop_tenant', status: 403 }));
  });
});
