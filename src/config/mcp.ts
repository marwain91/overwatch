import { z } from 'zod';

// MCP server configuration. The whole feature is opt-in; when `enabled` is false
// no /mcp or /oauth routes mount. `public_url` is the externally reachable base
// URL used as the OAuth issuer and the access-token audience — it MUST be set
// when enabled (validated in validateEnvironment).
export const McpConfigSchema = z.object({
  enabled: z.boolean().default(false).describe('Enable the remote MCP server and its OAuth endpoints'),
  public_url: z.string().default('').describe('Externally reachable base URL (OAuth issuer + token audience), e.g. https://overwatch.example.com'),
  access_token_ttl: z.string().default('1h').describe('Access token lifetime (jsonwebtoken expiresIn syntax)'),
  refresh_token_ttl: z.string().default('30d').describe('Refresh token lifetime (jsonwebtoken expiresIn syntax)'),
});

export type McpConfig = z.infer<typeof McpConfigSchema>;
