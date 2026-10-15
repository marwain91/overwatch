// src/mcp/server.ts
// MCP SDK pinned in Task 2: @modelcontextprotocol/sdk@1.29.0 (stable, single package).
import type { Express, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { ZodRawShape } from 'zod';
import { rateLimit } from '../middleware/rateLimit';
import { createOAuthRouter, OAuthRouterOptions } from '../routes/oauth';
import type { AdminRole } from '../services/users';
import { createTokenVerifier, McpAuthExtra } from './auth';
import { requireToolRole, ToolRoleError, writeMcpAudit } from './audit';
import {
  listAppsInput, listAppsHandler,
  listTenantsInput, listTenantsHandler,
  getTenantInput, getTenantHandler,
} from './tools/read';
import { lifecycleInput, startTenantHandler, stopTenantHandler, restartTenantHandler } from './tools/lifecycle';
import { updateTenantInput, updateTenantHandler } from './tools/update';

export interface MountMcpOptions extends OAuthRouterOptions {}

// requireBearerAuth sets req.auth = AuthInfo; the transport forwards it to the
// tool handler as `extra.authInfo`. Our verifier puts {email, role} in extra.extra.
function authFrom(extra: any): McpAuthExtra {
  const inner = extra?.authInfo?.extra;
  if (!inner?.email) throw new Error('missing auth context');
  return inner as McpAuthExtra;
}

// Build a progress notifier from the SDK request context: forwards to the client
// via extra.sendNotification using the request's progressToken (if the client sent one).
function makeNotifier(extra: any) {
  const progressToken = extra?._meta?.progressToken;
  return {
    notify: async (n: { progress: number; total?: number; message?: string }) => {
      if (progressToken === undefined || typeof extra?.sendNotification !== 'function') return;
      await extra.sendNotification({ method: 'notifications/progress', params: { progressToken, ...n } });
    },
  };
}

type ToolResult = { isError?: boolean; content: { type: 'text'; text: string }[]; structuredContent?: any };

/** A tool and the minimum role allowed to call it. The role is not optional. */
export interface McpToolSpec {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
  minRole: AdminRole;
  handler: (args: any, auth: McpAuthExtra, extra: any) => Promise<ToolResult>;
}

export const MCP_TOOLS: McpToolSpec[] = [
  { name: 'list_apps', description: 'List managed apps', inputSchema: listAppsInput.shape, minRole: 'viewer',
    handler: (args, auth) => listAppsHandler(args, auth) },
  { name: 'list_tenants', description: 'List tenants (optionally for one app)', inputSchema: listTenantsInput.shape, minRole: 'viewer',
    handler: (args, auth) => listTenantsHandler(args, auth) },
  { name: 'get_tenant', description: 'Get a tenant\'s current image tag and details', inputSchema: getTenantInput.shape, minRole: 'viewer',
    handler: (args, auth) => getTenantHandler(args, auth) },
  { name: 'start_tenant', description: 'Start a tenant\'s containers', inputSchema: lifecycleInput.shape, minRole: 'editor',
    handler: (args, auth) => startTenantHandler(args, auth) },
  { name: 'stop_tenant', description: 'Stop a tenant\'s containers', inputSchema: lifecycleInput.shape, minRole: 'editor',
    handler: (args, auth) => stopTenantHandler(args, auth) },
  { name: 'restart_tenant', description: 'Restart a tenant\'s containers', inputSchema: lifecycleInput.shape, minRole: 'editor',
    handler: (args, auth) => restartTenantHandler(args, auth) },
  { name: 'update_tenant', description: 'Update a tenant to a new image tag (streams progress)', inputSchema: updateTenantInput.shape, minRole: 'editor',
    handler: (args, auth, extra) => updateTenantHandler(args, auth, makeNotifier(extra)) },
];

/**
 * The SDK callback for a tool: resolves the caller, enforces the tool's
 * minimum role and audits a denial (as REST audits its 403s) before the
 * handler runs, so no tool can forget the check.
 */
export function guardedTool(spec: McpToolSpec) {
  return async (args: any, extra: any): Promise<ToolResult> => {
    const auth = authFrom(extra);
    try {
      requireToolRole(auth.role, spec.minRole);
    } catch (e) {
      if (!(e instanceof ToolRoleError)) throw e;
      writeMcpAudit({ email: auth.email, tool: spec.name, args, status: 403 });
      return { isError: true, content: [{ type: 'text', text: e.message }] };
    }
    return spec.handler(args, auth, extra);
  };
}

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'overwatch', version: '1' });

  // inputSchema is a ZodRawShape — pass the object's `.shape`, not the z.object().
  // The config arg is cast to `any`: registerTool's overload tries to deeply infer
  // the handler args type from the raw shape, which trips TS2589 (excessively deep)
  // on the multi-field schemas. The runtime values (shapes) are unchanged.
  const reg = server.registerTool.bind(server) as (name: string, cfg: any, cb: any) => void;
  for (const spec of MCP_TOOLS) {
    reg(spec.name, { description: spec.description, inputSchema: spec.inputSchema }, guardedTool(spec));
  }

  return server;
}

export function mountMcp(app: Express, opts: MountMcpOptions): void {
  const { issuer } = opts;

  // Rate-limit the OAuth endpoints (login/token/register call out to Google +
  // read admin-users) to blunt credential-stuffing / DoS.
  const oauthLimiter = rateLimit({ windowMs: 60_000, maxRequests: 20, message: 'Too many OAuth requests, slow down.' });
  app.use('/oauth', oauthLimiter);
  // Registration is unauthenticated and persists a client, so it gets a much
  // smaller budget; a real MCP client registers once per connection setup.
  const registerLimiter = rateLimit({ windowMs: 10 * 60_000, maxRequests: 10, message: 'Too many client registrations, slow down.' });
  app.post('/oauth/register', registerLimiter);

  // Even authenticated admins could flood /mcp; a modest limiter is cheap defense-in-depth.
  const mcpLimiter = rateLimit({ windowMs: 60_000, maxRequests: 60, message: 'Too many MCP requests, slow down.' });

  // OAuth endpoints + both .well-known metadata documents are served by our router.
  app.use(createOAuthRouter(opts));

  const verifier = createTokenVerifier({ issuer });
  // Point the 401 WWW-Authenticate at the protected-resource metadata our router serves.
  const resourceMetadataUrl = new URL('/.well-known/oauth-protected-resource', issuer).toString();
  const bearer = requireBearerAuth({ verifier, resourceMetadataUrl });

  // Stateless Streamable HTTP: a fresh McpServer + transport per request. Progress
  // notifications stream back over this same POST response.
  const handle = async (req: Request, res: Response) => {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, (req as any).body);
  };

  app.post('/mcp', mcpLimiter, bearer, handle);
  // Stateless mode has no standalone SSE stream; GET is not supported.
  app.get('/mcp', mcpLimiter, bearer, (_req: Request, res: Response) =>
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method Not Allowed: use POST' }, id: null }));
}
