import { describe, it, expect, vi, beforeEach } from 'vitest';

const updateTenant = vi.fn();
vi.mock('../services/tenant', () => ({ updateTenant: (...a: any[]) => updateTenant(...a), validateImageTag: () => ({ valid: true }) }));
const writeAuditEntry = vi.fn();
vi.mock('../middleware/audit', () => ({ writeAuditEntry: (...a: any[]) => writeAuditEntry(...a) }));

import { eventBus } from '../services/eventBus';
import { updateTenantHandler } from '../mcp/tools/update';

const editor = { email: 'a@b.c', role: 'editor' as const };
const viewer = { email: 'v@b.c', role: 'viewer' as const };

describe('update_tenant tool', () => {
  beforeEach(() => {
    updateTenant.mockReset();
    writeAuditEntry.mockReset();
  });

  it('forwards progress steps and returns success', async () => {
    const notes: any[] = [];
    updateTenant.mockImplementation(async (appId: string, tenantId: string) => {
      eventBus.emit('tenant:update:progress', { appId, tenantId, newTag: 'v2', step: 'pull', status: 'started' });
      eventBus.emit('tenant:update:progress', { appId, tenantId, newTag: 'v2', step: 'done', status: 'completed' });
    });
    const r = await updateTenantHandler({ appId: 'app1', tenantId: 't1', imageTag: 'v2' }, editor, { notify: async (n) => { notes.push(n); } });
    expect(r.isError).toBeFalsy();
    expect(notes.length).toBeGreaterThanOrEqual(2);
    expect(notes.some(n => n.message?.includes('pull'))).toBe(true);
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ path: '/mcp/update_tenant', status: 200 }));
  });

  it('unsubscribes after completion (no listener leak)', async () => {
    updateTenant.mockResolvedValue(undefined);
    const before = eventBus.listenerCount('tenant:update:progress');
    await updateTenantHandler({ appId: 'app1', tenantId: 't1', imageTag: 'v2' }, editor, { notify: async () => {} });
    expect(eventBus.listenerCount('tenant:update:progress')).toBe(before);
  });

  it('viewer is denied', async () => {
    const r = await updateTenantHandler({ appId: 'app1', tenantId: 't1', imageTag: 'v2' }, viewer, { notify: async () => {} });
    expect(r.isError).toBe(true);
    expect(updateTenant).not.toHaveBeenCalled();
  });

  it('returns tool error on update failure', async () => {
    updateTenant.mockRejectedValueOnce(new Error('pull failed'));
    const r = await updateTenantHandler({ appId: 'app1', tenantId: 't1', imageTag: 'v2' }, editor, { notify: async () => {} });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('pull failed');
  });
});
