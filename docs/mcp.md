# Overwatch MCP Server

Overwatch can expose a remote [Model Context Protocol](https://modelcontextprotocol.io)
server so AI clients (Claude, etc.) can manage tenants over the network. It is
**disabled by default**.

## Enabling

In `overwatch.yaml`:

```yaml
mcp:
  enabled: true
  public_url: https://overwatch.example.com   # externally reachable base URL
  access_token_ttl: 1h
  refresh_token_ttl: 30d
```

`public_url` is the OAuth issuer and the access-token audience; `/mcp` and
`/oauth/*` must be reachable at this URL through your reverse proxy (Traefik).
No new environment variables are needed — the MCP OAuth server reuses
`JWT_SECRET` and `GOOGLE_CLIENT_ID`. When `enabled` is false, none of the `/mcp`
or `/oauth/*` routes are mounted.

## Tools and required roles

| Tool | Min role |
|------|----------|
| `list_apps`, `list_tenants`, `get_tenant` | viewer |
| `update_tenant` | editor |
| `start_tenant`, `stop_tenant`, `restart_tenant` | editor |

Authorization reuses `admin-users.json`: only listed admins can sign in, and
their role gates which tools they can call. Role and membership are re-checked
on every request, so removing an admin revokes MCP access immediately.

## Connecting a client

1. Point your MCP client at `https://overwatch.example.com/mcp`.
2. The client discovers OAuth metadata (`/.well-known/oauth-protected-resource`
   and `/.well-known/oauth-authorization-server`), dynamically registers
   (RFC 7591), and opens the authorize URL — sign in with your Google admin
   account.
3. The client receives an access token (default 1h) + a rotating refresh token
   (default 30d) and calls tools. `update_tenant` streams progress notifications
   as it pulls the image, regenerates config, and recreates containers.

## Security notes

- OAuth 2.1 with PKCE (S256) is required; redirect URIs are exact-matched against
  the dynamically-registered client.
- Access tokens are scoped to the `/mcp` audience, distinct from the web-UI
  session token.
- Auth codes are single-use, 60s-lived, and held in memory — Overwatch assumes a
  single-process deployment per host.
- The OAuth endpoints are rate-limited.

See `docs/superpowers/specs/2026-06-01-overwatch-mcp-oauth-design.md` for the full
design and `docs/superpowers/plans/2026-06-01-overwatch-mcp-oauth.md` for the
implementation plan.
