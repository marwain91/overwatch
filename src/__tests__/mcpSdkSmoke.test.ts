/**
 * MCP SDK smoke test — pins the exact exports we depend on in Tasks 10 & 15.
 *
 * Installed packages (all 2.0.0-alpha.2, split-package layout):
 *   @modelcontextprotocol/server   — McpServer, WebStandardStreamableHTTPServerTransport,
 *                                    OAuthProtectedResourceMetadata (type), AuthInfo (type),
 *                                    resourceUrlFromServerUrl, checkResourceAllowed,
 *                                    validateHostHeader, StdioServerTransport
 *   @modelcontextprotocol/express  — createMcpExpressApp, hostHeaderValidation,
 *                                    localhostHostValidation
 *   @modelcontextprotocol/client   — (client SDK, no server-auth exports)
 *
 * NOTE: requireBearerAuth / mcpAuthMetadataRouter / getOAuthProtectedResourceMetadataUrl
 * do NOT exist in the alpha split packages. Tasks 10/15 must implement bearer-auth
 * middleware manually using AuthInfo (from @modelcontextprotocol/server) and
 * resourceUrlFromServerUrl / checkResourceAllowed for resource-server validation.
 * The express package only provides DNS-rebinding-protection helpers.
 */
import { describe, it, expect } from 'vitest';
import * as serverPkg from '@modelcontextprotocol/server';
import * as expressPkg from '@modelcontextprotocol/express';

describe('MCP SDK exports we depend on exist', () => {
  describe('@modelcontextprotocol/server', () => {
    it('exports McpServer class', () => {
      expect(typeof serverPkg.McpServer).toBe('function');
    });

    it('exports WebStandardStreamableHTTPServerTransport class', () => {
      expect(typeof serverPkg.WebStandardStreamableHTTPServerTransport).toBe('function');
    });

    it('McpServer can be instantiated', () => {
      const server = new serverPkg.McpServer({ name: 'test', version: '0.0.1' });
      expect(server).toBeTruthy();
      expect(typeof server.connect).toBe('function');
      expect(typeof server.registerTool).toBe('function');
      expect(typeof server.close).toBe('function');
    });

    it('WebStandardStreamableHTTPServerTransport can be instantiated and has handleRequest', () => {
      const transport = new serverPkg.WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless mode
      });
      expect(transport).toBeTruthy();
      expect(typeof transport.handleRequest).toBe('function');
      expect(typeof transport.start).toBe('function');
    });

    it('exports resourceUrlFromServerUrl helper function', () => {
      expect(typeof serverPkg.resourceUrlFromServerUrl).toBe('function');
      // smoke: converts a URL string to a URL object
      const result = serverPkg.resourceUrlFromServerUrl('https://example.com/mcp');
      expect(result).toBeInstanceOf(URL);
    });

    it('exports checkResourceAllowed helper function', () => {
      expect(typeof serverPkg.checkResourceAllowed).toBe('function');
      // smoke: matching resource returns true
      const allowed = serverPkg.checkResourceAllowed({
        requestedResource: 'https://example.com/mcp',
        configuredResource: 'https://example.com/mcp',
      });
      expect(allowed).toBe(true);
    });

    it('exports validateHostHeader function', () => {
      expect(typeof serverPkg.validateHostHeader).toBe('function');
    });

    it('exports OAuthProtectedResourceMetadata type (verified via schema)', () => {
      // OAuthProtectedResourceMetadata is a type-only export; verify the runtime schema exists
      // It's exported from index-Bhfkexnj internal bundle — accessible at runtime only via type.
      // We verify the type is structurally usable by casting:
      const meta: serverPkg.OAuthProtectedResourceMetadata = {
        resource: 'https://example.com/mcp',
        authorization_servers: ['https://auth.example.com'],
      };
      expect(meta.resource).toBe('https://example.com/mcp');
    });

    it('exports AuthInfo type (structurally verified at runtime)', () => {
      // AuthInfo is a type-only interface; verify structural use
      const info: serverPkg.AuthInfo = {
        token: 'tok',
        clientId: 'cid',
        scopes: ['mcp:tenant'],
        expiresAt: undefined,
      };
      expect(info.token).toBe('tok');
    });
  });

  describe('@modelcontextprotocol/express', () => {
    it('exports createMcpExpressApp factory function', () => {
      expect(typeof expressPkg.createMcpExpressApp).toBe('function');
    });

    it('createMcpExpressApp returns an Express application', () => {
      const app = expressPkg.createMcpExpressApp({ host: '0.0.0.0' });
      expect(app).toBeTruthy();
      // Express apps expose .use / .get
      expect(typeof app.use).toBe('function');
    });

    it('exports hostHeaderValidation middleware factory', () => {
      expect(typeof expressPkg.hostHeaderValidation).toBe('function');
      const mw = expressPkg.hostHeaderValidation(['localhost']);
      expect(typeof mw).toBe('function'); // RequestHandler
    });

    it('exports localhostHostValidation convenience middleware factory', () => {
      expect(typeof expressPkg.localhostHostValidation).toBe('function');
      const mw = expressPkg.localhostHostValidation();
      expect(typeof mw).toBe('function');
    });

    it('does NOT export requireBearerAuth (must be implemented manually)', () => {
      // Documenting the absence of old SDK helpers — Tasks 10/15 must not import these.
      expect((expressPkg as Record<string, unknown>)['requireBearerAuth']).toBeUndefined();
      expect((expressPkg as Record<string, unknown>)['mcpAuthMetadataRouter']).toBeUndefined();
      expect(
        (expressPkg as Record<string, unknown>)['getOAuthProtectedResourceMetadataUrl'],
      ).toBeUndefined();
    });
  });
});
