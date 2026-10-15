import { z } from 'zod';
import { updateTenant, validateImageTag } from '../../services/tenant';
import { writeMcpAudit, toolErrorMessage } from '../audit';
import { McpAuthExtra } from '../auth';
import { slugInput } from './read';
import type { TenantUpdateProgress } from '../../services/eventBus';
import { HttpError } from '../../utils/httpErrors';

type ToolResult = { isError?: boolean; content: { type: 'text'; text: string }[]; structuredContent?: any };

export interface ProgressNotification {
  progress: number;
  total?: number;
  message?: string;
}
export interface UpdateToolContext {
  notify: (n: ProgressNotification) => Promise<void>;
}

export const updateTenantInput = z.object({
  appId: slugInput,
  tenantId: slugInput,
  imageTag: z.string(),
});

// Maps the known update steps to a coarse progress fraction for clients that
// render a bar; message carries the human-readable step+status.
const STEP_ORDER: Record<string, number> = { manifest: 1, config: 2, pull: 3, restart: 4, done: 5, failed: 5 };

// Role (editor) is enforced where the tool is registered (mcp/server.ts).
export async function updateTenantHandler(
  args: z.infer<typeof updateTenantInput>,
  auth: McpAuthExtra,
  ctx: UpdateToolContext,
): Promise<ToolResult> {
  const tag = validateImageTag(args.imageTag);
  if (!tag.valid) return { isError: true, content: [{ type: 'text', text: tag.error || 'invalid image tag' }] };

  const onProgress = (p: TenantUpdateProgress) => {
    // Fire-and-forget; notify errors must not break the update.
    void ctx.notify({
      progress: STEP_ORDER[p.step] ?? 0,
      total: 5,
      message: `${p.step}: ${p.status}${p.detail ? ` — ${p.detail}` : ''}`,
    }).catch(() => {});
  };
  try {
    await updateTenant(args.appId, args.tenantId, args.imageTag, onProgress);
    writeMcpAudit({ email: auth.email, tool: 'update_tenant', args, status: 200 });
    return { content: [{ type: 'text', text: `Updated ${args.appId}/${args.tenantId} to ${args.imageTag}` }], structuredContent: { success: true, ...args } };
  } catch (e: any) {
    writeMcpAudit({ email: auth.email, tool: 'update_tenant', args, status: e instanceof HttpError ? e.status : 500 });
    return { isError: true, content: [{ type: 'text', text: toolErrorMessage(e, 'Failed to update tenant') }] };
  }
}
