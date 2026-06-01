import { mcpResourceUrl } from './tokens';

// RFC 8414 Authorization Server Metadata (subset MCP clients consume).
export function authorizationServerMetadata(issuer: string) {
  const u = (p: string) => new URL(p, issuer).toString();
  return {
    issuer,
    authorization_endpoint: u('/oauth/authorize'),
    token_endpoint: u('/oauth/token'),
    registration_endpoint: u('/oauth/register'),
    revocation_endpoint: u('/oauth/revoke'),
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'], // public clients (PKCE)
  };
}

// RFC 9728 Protected Resource Metadata.
export function protectedResourceMetadata(issuer: string) {
  return {
    resource: mcpResourceUrl(issuer),
    authorization_servers: [issuer],
  };
}
