import { z } from 'zod';
import { listApps } from '../../services/app';
import { listTenants, getTenantInfo } from '../../services/docker';
import { requireToolRole } from '../audit';
import { McpAuthExtra } from '../auth';

type ToolResult = { isError?: boolean; content: { type: 'text'; text: string }[]; structuredContent?: any };

function ok(structured: any, text: string): ToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}
function err(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export const listAppsInput = z.object({});
export async function listAppsHandler(_args: unknown, auth: McpAuthExtra): Promise<ToolResult> {
  requireToolRole(auth.role, 'viewer');
  const apps = await listApps();
  const slim = apps.map(a => ({ id: a.id, name: a.name }));
  return ok({ apps: slim }, `${slim.length} app(s)`);
}

export const listTenantsInput = z.object({ appId: z.string().optional() });
export async function listTenantsHandler(args: z.infer<typeof listTenantsInput>, auth: McpAuthExtra): Promise<ToolResult> {
  requireToolRole(auth.role, 'viewer');
  const all = await listTenants();
  const tenants = args.appId ? all.filter(t => t.appId === args.appId) : all;
  return ok({ tenants }, `${tenants.length} tenant(s)`);
}

export const getTenantInput = z.object({ appId: z.string(), tenantId: z.string() });
export async function getTenantHandler(args: z.infer<typeof getTenantInput>, auth: McpAuthExtra): Promise<ToolResult> {
  requireToolRole(auth.role, 'viewer');
  const info = await getTenantInfo(args.appId, args.tenantId);
  if (!info) return err(`Tenant ${args.appId}/${args.tenantId} not found`);
  return ok(info, `${info.appId}/${info.tenantId} @ ${info.version}`);
}
