import { writeAuditEntry } from '../middleware/audit';
import { AdminRole, can } from '../services/users';

export class ToolRoleError extends Error {
  constructor(public required: AdminRole, public actual: AdminRole) {
    super(`This action requires '${required}' role; yours is '${actual}'.`);
    this.name = 'ToolRoleError';
  }
}

export function requireToolRole(actual: AdminRole, required: AdminRole): void {
  if (!can(actual, required)) throw new ToolRoleError(required, actual);
}

export function writeMcpAudit(entry: {
  email: string;
  tool: string;
  args?: Record<string, unknown>;
  status: number;
}): void {
  writeAuditEntry({
    user: entry.email,
    action: entry.tool,
    method: 'MCP',
    path: `/mcp/${entry.tool}`,
    body: entry.args,
    status: entry.status,
    ip: 'mcp',
  });
}
