import { describe, it, expect, vi } from 'vitest';

const writeAuditEntry = vi.fn();
vi.mock('../middleware/audit', () => ({ writeAuditEntry: (...a: any[]) => writeAuditEntry(...a) }));

import { writeMcpAudit, requireToolRole, ToolRoleError } from '../mcp/audit';

describe('mcp audit + role guard', () => {
  it('writes an audit entry tagged as MCP', () => {
    writeMcpAudit({ email: 'a@b.c', tool: 'update_tenant', args: { appId: 'x', tenantId: 'y', imageTag: 'v2' }, status: 200 });
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
      user: 'a@b.c', method: 'MCP', path: '/mcp/update_tenant', status: 200,
    }));
  });

  it('requireToolRole throws ToolRoleError when role is insufficient', () => {
    expect(() => requireToolRole('viewer', 'editor')).toThrow(ToolRoleError);
  });

  it('requireToolRole passes when role is sufficient', () => {
    expect(() => requireToolRole('admin', 'editor')).not.toThrow();
  });
});
