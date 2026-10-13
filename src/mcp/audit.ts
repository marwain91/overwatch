import { writeAuditEntry } from '../middleware/audit';
import { AdminRole, can } from '../services/users';
import { HttpError } from '../utils/httpErrors';

export class ToolRoleError extends Error {
  constructor(public required: AdminRole, public actual: AdminRole) {
    super(`This action requires '${required}' role; yours is '${actual}'.`);
    this.name = 'ToolRoleError';
  }
}

// One rule for every MCP tool: exposed HttpErrors (incl. DockerCommandError) pass
// their message through; anything else is logged and replaced by a generic one.
export function toolErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof HttpError && e.expose) return e.clientMessage;
  console.error(`[mcp] ${fallback}:`, e);
  return fallback;
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
