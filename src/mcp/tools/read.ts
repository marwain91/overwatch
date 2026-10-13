import { z } from 'zod';
import { listApps } from '../../services/app';
import { listTenants, getTenantInfo } from '../../services/docker';
import { requireToolRole, ToolRoleError } from '../audit';
import { McpAuthExtra } from '../auth';
import { SLUG_RE } from '../../utils/validators';
import { HttpError } from '../../utils/httpErrors';

// Same slug rule REST enforces via validateAppId/validateTenantId.
export const slugInput = z.string().max(63).regex(SLUG_RE, 'must be a lowercase slug (a-z, 0-9, -)');

type ToolResult = { isError?: boolean; content: { type: 'text'; text: string }[]; structuredContent?: any };

function ok(structured: any, text: string): ToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}
function err(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

// Wrap a read handler: enforce the viewer gate and convert thrown errors into
// MCP tool error results. Role denials and exposed HttpErrors surface their (safe) message; any other
// unexpected error returns a generic message (the raw error — which may carry a
// filesystem path — is logged server-side, never returned to the client).
async function guardRead(auth: McpAuthExtra, action: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    requireToolRole(auth.role, 'viewer');
    return await fn();
  } catch (e) {
    if (e instanceof ToolRoleError) return err(e.message);
    if (e instanceof HttpError && e.expose) return err(e.message);
    console.error(`[mcp] ${action} failed:`, e);
    return err(`Failed to ${action}`);
  }
}

export const listAppsInput = z.object({});
export async function listAppsHandler(_args: unknown, auth: McpAuthExtra): Promise<ToolResult> {
  return guardRead(auth, 'list apps', async () => {
    const apps = await listApps();
    const slim = apps.map(a => ({ id: a.id, name: a.name }));
    return ok({ apps: slim }, `${slim.length} app(s)`);
  });
}

export const listTenantsInput = z.object({ appId: slugInput.optional() });
export async function listTenantsHandler(args: z.infer<typeof listTenantsInput>, auth: McpAuthExtra): Promise<ToolResult> {
  return guardRead(auth, 'list tenants', async () => {
    const all = await listTenants();
    const tenants = args.appId ? all.filter(t => t.appId === args.appId) : all;
    return ok({ tenants }, `${tenants.length} tenant(s)`);
  });
}

export const getTenantInput = z.object({ appId: slugInput, tenantId: slugInput });
export async function getTenantHandler(args: z.infer<typeof getTenantInput>, auth: McpAuthExtra): Promise<ToolResult> {
  return guardRead(auth, 'get tenant', async () => {
    const info = await getTenantInfo(args.appId, args.tenantId);
    if (!info) return err(`Tenant ${args.appId}/${args.tenantId} not found`);
    return ok(info, `${info.appId}/${info.tenantId} @ ${info.version}`);
  });
}
