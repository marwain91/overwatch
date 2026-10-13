import { describe, it, expect } from 'vitest';
import { getTenantInput, listTenantsInput } from '../mcp/tools/read';
import { lifecycleInput } from '../mcp/tools/lifecycle';
import { updateTenantInput } from '../mcp/tools/update';

describe('MCP tool inputs use the same slug rule as REST', () => {
  it('rejects traversal-shaped and non-slug ids at the tool boundary', () => {
    expect(lifecycleInput.safeParse({ appId: '../etc', tenantId: 't1' }).success).toBe(false);
    expect(getTenantInput.safeParse({ appId: 'app1', tenantId: 'T1' }).success).toBe(false);
    expect(updateTenantInput.safeParse({ appId: 'app1', tenantId: 'a/b', imageTag: '1.0.0' }).success).toBe(false);
    expect(listTenantsInput.safeParse({ appId: 'x'.repeat(64) }).success).toBe(false);
  });

  it('accepts ordinary slugs', () => {
    expect(lifecycleInput.safeParse({ appId: 'customer-portal', tenantId: 'tenant-one' }).success).toBe(true);
    expect(listTenantsInput.safeParse({}).success).toBe(true);
  });
});
