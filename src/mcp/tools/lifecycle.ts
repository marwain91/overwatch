import { z } from 'zod';
import { startTenant, stopTenant, restartTenant } from '../../services/docker';
import { writeMcpAudit, toolErrorMessage } from '../audit';
import { McpAuthExtra } from '../auth';
import { slugInput } from './read';
import { HttpError } from '../../utils/httpErrors';

type ToolResult = { isError?: boolean; content: { type: 'text'; text: string }[]; structuredContent?: any };

export const lifecycleInput = z.object({ appId: slugInput, tenantId: slugInput });

function makeLifecycleHandler(tool: string, fn: (appId: string, tenantId: string) => Promise<void>) {
  // Role (editor) is enforced where the tool is registered (mcp/server.ts).
  return async (args: z.infer<typeof lifecycleInput>, auth: McpAuthExtra): Promise<ToolResult> => {
    try {
      await fn(args.appId, args.tenantId);
      writeMcpAudit({ email: auth.email, tool, args, status: 200 });
      return { content: [{ type: 'text', text: `${tool} ok for ${args.appId}/${args.tenantId}` }], structuredContent: { success: true, ...args } };
    } catch (e: any) {
      writeMcpAudit({ email: auth.email, tool, args, status: e instanceof HttpError ? e.status : 500 });
      return { isError: true, content: [{ type: 'text', text: toolErrorMessage(e, `Failed to ${tool}`) }] };
    }
  };
}

export const startTenantHandler = makeLifecycleHandler('start_tenant', startTenant);
export const stopTenantHandler = makeLifecycleHandler('stop_tenant', stopTenant);
export const restartTenantHandler = makeLifecycleHandler('restart_tenant', restartTenant);
