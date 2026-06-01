import { z } from 'zod';
import { startTenant, stopTenant, restartTenant } from '../../services/docker';
import { requireToolRole, writeMcpAudit, ToolRoleError } from '../audit';
import { McpAuthExtra } from '../auth';

type ToolResult = { isError?: boolean; content: { type: 'text'; text: string }[]; structuredContent?: any };

export const lifecycleInput = z.object({ appId: z.string(), tenantId: z.string() });

function makeLifecycleHandler(tool: string, fn: (appId: string, tenantId: string) => Promise<void>) {
  return async (args: z.infer<typeof lifecycleInput>, auth: McpAuthExtra): Promise<ToolResult> => {
    try {
      requireToolRole(auth.role, 'editor');
    } catch (e) {
      if (e instanceof ToolRoleError) return { isError: true, content: [{ type: 'text', text: e.message }] };
      throw e;
    }
    try {
      await fn(args.appId, args.tenantId);
      writeMcpAudit({ email: auth.email, tool, args, status: 200 });
      return { content: [{ type: 'text', text: `${tool} ok for ${args.appId}/${args.tenantId}` }], structuredContent: { success: true, ...args } };
    } catch (e: any) {
      writeMcpAudit({ email: auth.email, tool, args, status: 500 });
      return { isError: true, content: [{ type: 'text', text: e?.message || String(e) }] };
    }
  };
}

export const startTenantHandler = makeLifecycleHandler('start_tenant', startTenant);
export const stopTenantHandler = makeLifecycleHandler('stop_tenant', stopTenant);
export const restartTenantHandler = makeLifecycleHandler('restart_tenant', restartTenant);
