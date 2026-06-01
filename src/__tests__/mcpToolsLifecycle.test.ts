import { describe, it, expect, vi } from 'vitest';

const { startTenant, stopTenant, restartTenant, writeAuditEntry } = vi.hoisted(() => ({
  startTenant: vi.fn(async () => {}),
  stopTenant: vi.fn(async () => {}),
  restartTenant: vi.fn(async () => {}),
  writeAuditEntry: vi.fn(),
}));

vi.mock('../services/docker', () => ({ startTenant, stopTenant, restartTenant }));
vi.mock('../middleware/audit', () => ({ writeAuditEntry: (...a: any[]) => writeAuditEntry(...a) }));

import { startTenantHandler, stopTenantHandler, restartTenantHandler } from '../mcp/tools/lifecycle';

const editor = { email: 'a@b.c', role: 'editor' as const };
const viewer = { email: 'v@b.c', role: 'viewer' as const };

describe('lifecycle tools', () => {
  it('editor can start; service + audit invoked', async () => {
    const r = await startTenantHandler({ appId: 'app1', tenantId: 't1' }, editor);
    expect(r.isError).toBeFalsy();
    expect(startTenant).toHaveBeenCalledWith('app1', 't1');
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ method: 'MCP', path: '/mcp/start_tenant' }));
  });

  it('viewer is denied with a tool error', async () => {
    const r = await stopTenantHandler({ appId: 'app1', tenantId: 't1' }, viewer);
    expect(r.isError).toBe(true);
    expect(stopTenant).not.toHaveBeenCalled();
  });

  it('restart surfaces service failure as a tool error', async () => {
    restartTenant.mockRejectedValueOnce(new Error('compose boom'));
    const r = await restartTenantHandler({ appId: 'app1', tenantId: 't1' }, editor);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('compose boom');
  });
});
