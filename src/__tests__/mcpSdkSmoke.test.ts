/**
 * MCP SDK smoke test — pins the exact exports we depend on in Tasks 10 & 15.
 *
 * Installed package: @modelcontextprotocol/sdk@^1 (single stable package, 1.x subpath exports)
 *
 * Subpath import specifiers confirmed from package.json exports map:
 *   @modelcontextprotocol/sdk/server/mcp.js      — McpServer (high-level server class)
 *   @modelcontextprotocol/sdk/server/streamableHttp.js  — StreamableHTTPServerTransport (Node.js HTTP)
 *   @modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js — requireBearerAuth middleware
 *   @modelcontextprotocol/sdk/server/auth/router.js      — mcpAuthMetadataRouter, getOAuthProtectedResourceMetadataUrl
 *   @modelcontextprotocol/sdk/server/auth/provider.js    — OAuthTokenVerifier interface
 *   @modelcontextprotocol/sdk/server/auth/types.js       — AuthInfo interface
 *   @modelcontextprotocol/sdk/server/express.js          — createMcpExpressApp helper
 *
 * Key findings:
 *   - requireBearerAuth IS present in 1.x (was absent from alpha split packages).
 *   - mcpAuthMetadataRouter and getOAuthProtectedResourceMetadataUrl ARE present.
 *   - Tool handler receives (args, extra: RequestHandlerExtra) where:
 *       extra.authInfo?: AuthInfo
 *       extra._meta?.progressToken?: string | number
 *       extra.sendNotification(notification) — to emit progress notifications
 *   - StreamableHTTPServerTransport.handleRequest(req, res, parsedBody?) is the Express hook.
 *   - requireBearerAuth options: { verifier: OAuthTokenVerifier, requiredScopes?, resourceMetadataUrl? }
 *   - AuthInfo shape: { token, clientId, scopes, expiresAt?, resource?: URL, extra? }
 */
import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import {
  mcpAuthMetadataRouter,
  getOAuthProtectedResourceMetadataUrl,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';

describe('MCP SDK 1.x exports we depend on', () => {
  describe('McpServer (@modelcontextprotocol/sdk/server/mcp.js)', () => {
    it('is a constructor function', () => {
      expect(typeof McpServer).toBe('function');
    });

    it('can be instantiated with { name, version }', () => {
      const server = new McpServer({ name: 'overwatch-mcp', version: '1.0.0' });
      expect(server).toBeTruthy();
    });

    it('exposes connect, close, registerTool, isConnected methods', () => {
      const server = new McpServer({ name: 'test', version: '0.0.1' });
      expect(typeof server.connect).toBe('function');
      expect(typeof server.close).toBe('function');
      expect(typeof server.registerTool).toBe('function');
      expect(typeof server.isConnected).toBe('function');
    });

    it('registerTool accepts (name, config, handler) — config has description and inputSchema', () => {
      const server = new McpServer({ name: 'test', version: '0.0.1' });
      // registerTool(name, { title?, description?, inputSchema?, annotations?, _meta? }, handler)
      // handler signature: (args, extra) where extra.authInfo?: AuthInfo, extra._meta?.progressToken
      const tool = server.registerTool(
        'ping',
        { description: 'A test tool' },
        // extra: RequestHandlerExtra — has authInfo?, _meta?.progressToken, sendNotification
        (_extra) => ({ content: [{ type: 'text' as const, text: 'pong' }] }),
      );
      expect(tool).toBeTruthy();
      expect(typeof tool.enable).toBe('function');
      expect(typeof tool.disable).toBe('function');
    });
  });

  describe('StreamableHTTPServerTransport (@modelcontextprotocol/sdk/server/streamableHttp.js)', () => {
    it('is a constructor function', () => {
      expect(typeof StreamableHTTPServerTransport).toBe('function');
    });

    it('can be instantiated in stateless mode (sessionIdGenerator: undefined)', () => {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      expect(transport).toBeTruthy();
    });

    it('exposes handleRequest(req, res, parsedBody?) for Express integration', () => {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      // handleRequest(req: IncomingMessage & { auth?: AuthInfo }, res: ServerResponse, parsedBody?: unknown)
      expect(typeof transport.handleRequest).toBe('function');
    });

    it('exposes start() and close() lifecycle methods', () => {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      expect(typeof transport.start).toBe('function');
      expect(typeof transport.close).toBe('function');
    });
  });

  describe('requireBearerAuth (@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js)', () => {
    it('is a factory function', () => {
      expect(typeof requireBearerAuth).toBe('function');
    });

    it('returns an Express RequestHandler when given a verifier', () => {
      // BearerAuthMiddlewareOptions: { verifier: OAuthTokenVerifier, requiredScopes?, resourceMetadataUrl? }
      // OAuthTokenVerifier: { verifyAccessToken(token: string): Promise<AuthInfo> }
      const verifier = {
        verifyAccessToken: async (_token: string) => ({
          token: _token,
          clientId: 'test-client',
          scopes: ['mcp:tenant'],
        }),
      };
      const middleware = requireBearerAuth({ verifier });
      expect(typeof middleware).toBe('function');
    });

    it('accepts optional requiredScopes and resourceMetadataUrl options', () => {
      const verifier = {
        verifyAccessToken: async (_token: string) => ({
          token: _token,
          clientId: 'test-client',
          scopes: ['mcp:tenant'],
        }),
      };
      const middleware = requireBearerAuth({
        verifier,
        requiredScopes: ['mcp:tenant'],
        resourceMetadataUrl: 'https://example.com/.well-known/oauth-protected-resource/mcp',
      });
      expect(typeof middleware).toBe('function');
    });
  });

  describe('Protected Resource Metadata helpers (@modelcontextprotocol/sdk/server/auth/router.js)', () => {
    it('mcpAuthMetadataRouter is a function (creates an Express Router)', () => {
      expect(typeof mcpAuthMetadataRouter).toBe('function');
    });

    it('getOAuthProtectedResourceMetadataUrl constructs the .well-known URL from server URL', () => {
      expect(typeof getOAuthProtectedResourceMetadataUrl).toBe('function');
      const result = getOAuthProtectedResourceMetadataUrl(
        new URL('https://api.example.com/mcp'),
      );
      // Per spec: https://api.example.com/.well-known/oauth-protected-resource/mcp
      expect(result).toContain('.well-known/oauth-protected-resource');
    });
  });

  describe('createMcpExpressApp (@modelcontextprotocol/sdk/server/express.js)', () => {
    it('is a factory function', () => {
      expect(typeof createMcpExpressApp).toBe('function');
    });

    it('returns an Express application with .use() and .get()', () => {
      const app = createMcpExpressApp({ host: '0.0.0.0' });
      expect(typeof app.use).toBe('function');
      expect(typeof app.get).toBe('function');
    });
  });
});
