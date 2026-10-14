import { describe, it, expect, vi, beforeEach } from 'vitest';

const { updateTenant, validateImageTag } = vi.hoisted(() => ({
  updateTenant: vi.fn(),
  validateImageTag: vi.fn((_imageTag: unknown): { valid: boolean; error?: string } => ({ valid: true })),
}));

vi.mock('../services/tenant', () => ({
  updateTenant: (...a: any[]) => updateTenant(...a),
  validateImageTag: (imageTag: unknown) => validateImageTag(imageTag),
}));

vi.mock('../mcp/audit', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, writeMcpAudit: vi.fn() };
});

import { HttpError } from '../utils/httpErrors';
import { eventBus } from '../services/eventBus';
import { updateTenantHandler } from '../mcp/tools/update';
import { writeMcpAudit } from '../mcp/audit';

const editor = { email: 'a@b.c', role: 'editor' as const };
const viewer = { email: 'v@b.c', role: 'viewer' as const };

describe('update_tenant tool', () => {
  beforeEach(() => {
    updateTenant.mockReset();
    validateImageTag.mockReset();
    validateImageTag.mockReturnValue({ valid: true });
    vi.mocked(writeMcpAudit).mockReset();
  });

  it('forwards progress steps and returns success', async () => {
    const notes: any[] = [];
    updateTenant.mockImplementation(async (appId: string, tenantId: string, _tag: string, onProgress?: (p: any) => void) => {
      onProgress?.({ appId, tenantId, newTag: 'v2', step: 'pull', status: 'started' });
      onProgress?.({ appId, tenantId, newTag: 'v2', step: 'done', status: 'completed' });
    });
    const r = await updateTenantHandler({ appId: 'app1', tenantId: 't1', imageTag: 'v2' }, editor, { notify: async (n) => { notes.push(n); } });
    expect(r.isError).toBeFalsy();
    expect(notes.length).toBeGreaterThanOrEqual(2);
    expect(notes.some(n => n.message?.includes('pull'))).toBe(true);
    expect(writeMcpAudit).toHaveBeenCalledWith(expect.objectContaining({ tool: 'update_tenant', status: 200, email: 'a@b.c' }));
  });

  it('does not listen on the global bus (progress comes through the callback)', async () => {
    const notes: any[] = [];
    updateTenant.mockImplementation(async (appId: string, tenantId: string) => {
      // Another tenant's progress on the global bus must not reach this call.
      eventBus.emit('tenant:update:progress', { appId, tenantId, newTag: 'v2', step: 'pull', status: 'started' });
    });
    const before = eventBus.listenerCount('tenant:update:progress');
    await updateTenantHandler({ appId: 'app1', tenantId: 't1', imageTag: 'v2' }, editor, { notify: async (n) => { notes.push(n); } });
    expect(eventBus.listenerCount('tenant:update:progress')).toBe(before);
    expect(notes).toEqual([]);
  });

  it('viewer is denied', async () => {
    const r = await updateTenantHandler({ appId: 'app1', tenantId: 't1', imageTag: 'v2' }, viewer, { notify: async () => {} });
    expect(r.isError).toBe(true);
    expect(updateTenant).not.toHaveBeenCalled();
  });

  it('returns tool error on update failure', async () => {
    updateTenant.mockRejectedValueOnce(new HttpError(500, 'pull failed', { expose: true }));
    const r = await updateTenantHandler({ appId: 'app1', tenantId: 't1', imageTag: 'v2' }, editor, { notify: async () => {} });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('pull failed');
  });

  it('hides the message of an unexpected update failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    updateTenant.mockRejectedValueOnce(new Error('ENOENT: /srv/apps/x/.env'));
    const r = await updateTenantHandler({ appId: 'app1', tenantId: 't1', imageTag: 'v2' }, editor, { notify: async () => {} });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('Failed to update tenant');
  });

  it('rejects an invalid image tag with a tool error (update not called)', async () => {
    validateImageTag.mockReturnValueOnce({ valid: false, error: 'bad tag' });
    const r = await updateTenantHandler({ appId: 'app1', tenantId: 't1', imageTag: 'BAD!' }, editor, { notify: async () => {} });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('bad tag');
    expect(updateTenant).not.toHaveBeenCalled();
  });
});
