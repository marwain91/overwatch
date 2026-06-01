import { describe, it, expect, vi } from 'vitest';

vi.mock('../services/app', () => ({ listApps: vi.fn(async () => [{ id: 'app1', name: 'App One' }]) }));
vi.mock('../services/docker', () => ({
  listTenants: vi.fn(async () => [{ appId: 'app1', tenantId: 't1', domain: 'd', version: 'v1', healthy: true, runningContainers: 1, totalContainers: 1, containers: [] }]),
  getTenantInfo: vi.fn(async (a: string, t: string) => a === 'app1' && t === 't1' ? { appId: 'app1', tenantId: 't1', domain: 'd', version: 'v1' } : null),
}));

import { listAppsHandler, listTenantsHandler, getTenantHandler } from '../mcp/tools/read';

const viewer = { email: 'a@b.c', role: 'viewer' as const };

describe('read tools', () => {
  it('list_apps returns apps for a viewer', async () => {
    const r = await listAppsHandler({}, viewer);
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.apps[0].id).toBe('app1');
  });

  it('list_tenants filters by appId', async () => {
    const r = await listTenantsHandler({ appId: 'app1' }, viewer);
    expect(r.structuredContent.tenants).toHaveLength(1);
    expect(r.structuredContent.tenants[0].tenantId).toBe('t1');
  });

  it('get_tenant returns error for an unknown tenant', async () => {
    const r = await getTenantHandler({ appId: 'app1', tenantId: 'nope' }, viewer);
    expect(r.isError).toBe(true);
  });

  it('does not leak internal error detail (e.g. file paths) on an unexpected failure', async () => {
    const app = await import('../services/app');
    (app.listApps as any).mockRejectedValueOnce(new Error('ENOENT: /srv/secret/path/apps.json'));
    const r = await listAppsHandler({}, viewer);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('Failed to list apps');
    expect(r.content[0].text).not.toContain('/srv/secret');
  });
});
