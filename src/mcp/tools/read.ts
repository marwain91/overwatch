import { z } from 'zod';
import { listApps } from '../../services/app';
import { listTenants, getTenantInfo } from '../../services/docker';
import { toolErrorMessage } from '../audit';
import { McpAuthExtra } from '../auth';
import { SLUG_RE } from '../../utils/validators';

// Same slug rule REST enforces via validateAppId/validateTenantId.
export const slugInput = z.string().max(63).regex(SLUG_RE, 'must be a lowercase slug (a-z, 0-9, -)');

type ToolResult = { isError?: boolean; content: { type: 'text'; text: string }[]; structuredContent?: any };

function ok(structured: any, text: string): ToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}
function err(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

// Wrap a read handler: convert thrown errors into MCP tool error results.
// Exposed HttpErrors surface their (safe) message; any other unexpected error
// returns a generic message (the raw error — which may carry a filesystem
// path — is logged server-side, never returned to the client). The role
// (viewer) is enforced where the tool is registered (mcp/server.ts).
async function guardRead(_auth: McpAuthExtra, action: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    return err(toolErrorMessage(e, `Failed to ${action}`));
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
