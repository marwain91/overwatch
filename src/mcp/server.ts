// src/mcp/server.ts
// MCP SDK pinned in Task 2: @modelcontextprotocol/sdk@1.29.0 (stable, single package).
import type { Express, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { rateLimit } from '../middleware/rateLimit';
import { createOAuthRouter, OAuthRouterOptions } from '../routes/oauth';
import { createTokenVerifier, McpAuthExtra } from './auth';
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

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'overwatch', version: '1' });

  // inputSchema is a ZodRawShape — pass the object's `.shape`, not the z.object().
  // The config arg is cast to `any`: registerTool's overload tries to deeply infer
  // the handler args type from the raw shape, which trips TS2589 (excessively deep)
  // on the multi-field schemas. The runtime values (shapes) are unchanged.
  const reg = server.registerTool.bind(server) as (name: string, cfg: any, cb: any) => void;

  reg('list_apps', { description: 'List managed apps', inputSchema: listAppsInput.shape },
    async (args: any, extra: any) => listAppsHandler(args, authFrom(extra)) as any);
  reg('list_tenants', { description: 'List tenants (optionally for one app)', inputSchema: listTenantsInput.shape },
    async (args: any, extra: any) => listTenantsHandler(args, authFrom(extra)) as any);
  reg('get_tenant', { description: 'Get a tenant\'s current image tag and details', inputSchema: getTenantInput.shape },
    async (args: any, extra: any) => getTenantHandler(args, authFrom(extra)) as any);

  reg('start_tenant', { description: 'Start a tenant\'s containers', inputSchema: lifecycleInput.shape },
    async (args: any, extra: any) => startTenantHandler(args, authFrom(extra)) as any);
  reg('stop_tenant', { description: 'Stop a tenant\'s containers', inputSchema: lifecycleInput.shape },
    async (args: any, extra: any) => stopTenantHandler(args, authFrom(extra)) as any);
  reg('restart_tenant', { description: 'Restart a tenant\'s containers', inputSchema: lifecycleInput.shape },
    async (args: any, extra: any) => restartTenantHandler(args, authFrom(extra)) as any);

  reg('update_tenant', { description: 'Update a tenant to a new image tag (streams progress)', inputSchema: updateTenantInput.shape },
    async (args: any, extra: any) => updateTenantHandler(args, authFrom(extra), makeNotifier(extra)) as any);

  return server;
}

export function mountMcp(app: Express, opts: MountMcpOptions): void {
  const { issuer } = opts;

  // Rate-limit the OAuth endpoints (login/token/register call out to Google +
  // read admin-users) to blunt credential-stuffing / DoS.
  const oauthLimiter = rateLimit({ windowMs: 60_000, maxRequests: 20, message: 'Too many OAuth requests, slow down.' });
  app.use('/oauth', oauthLimiter);

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
