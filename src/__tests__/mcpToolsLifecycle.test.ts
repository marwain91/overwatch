import { describe, it, expect, vi } from 'vitest';

const { startTenant, stopTenant, restartTenant, writeAuditEntry } = vi.hoisted(() => ({
  startTenant: vi.fn(async () => {}),
  stopTenant: vi.fn(async () => {}),
  restartTenant: vi.fn(async () => {}),
  writeAuditEntry: vi.fn(),
}));

vi.mock('../services/docker', () => ({ startTenant, stopTenant, restartTenant }));
vi.mock('../services/auditLog', () => ({ writeAuditEntry: (...a: any[]) => writeAuditEntry(...a) }));

import { HttpError } from '../utils/httpErrors';
import { startTenantHandler, restartTenantHandler } from '../mcp/tools/lifecycle';
import { MCP_TOOLS, guardedTool } from '../mcp/server';

const editor = { email: 'a@b.c', role: 'editor' as const };
const viewer = { email: 'v@b.c', role: 'viewer' as const };

describe('lifecycle tools', () => {
  it('editor can start; service + audit invoked', async () => {
    const r = await startTenantHandler({ appId: 'app1', tenantId: 't1' }, editor);
    expect(r.isError).toBeFalsy();
    expect(startTenant).toHaveBeenCalledWith('app1', 't1');
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ method: 'MCP', path: '/mcp/start_tenant' }));
  });

  it('viewer is denied with a tool error (gate applied at registration)', async () => {
    const stop = guardedTool(MCP_TOOLS.find(t => t.name === 'stop_tenant')!);
    const r = await stop({ appId: 'app1', tenantId: 't1' }, { authInfo: { extra: viewer } });
    expect(r.isError).toBe(true);
    expect(stopTenant).not.toHaveBeenCalled();
  });

  it('restart surfaces an exposed operational failure as a tool error', async () => {
    restartTenant.mockRejectedValueOnce(new HttpError(503, 'Cannot connect to the Docker daemon', { expose: true }));
    const r = await restartTenantHandler({ appId: 'app1', tenantId: 't1' }, editor);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Cannot connect to the Docker daemon');
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ status: 503 }));
  });

  it('restart hides the message of an unexpected failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    restartTenant.mockRejectedValueOnce(new Error("ENOENT: /srv/apps/x/.env"));
    const r = await restartTenantHandler({ appId: 'app1', tenantId: 't1' }, editor);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('Failed to restart_tenant');
  });
});
