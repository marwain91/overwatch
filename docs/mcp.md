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

`appId` and `tenantId` must be lowercase slugs (`a-z`, `0-9`, `-`, up to 63 characters), the same rule the REST API enforces.

Authorization reuses `admin-users.json`: only listed admins can sign in, and
their role gates which tools they can call. Every tool is registered with its
minimum role and the check runs before the tool, so a call below that role
returns a tool error and is written to the audit log with status 403, as a
refused REST call is. Role and membership are re-checked
on every request, so removing an admin revokes MCP access immediately.

## Connecting a client

1. Point your MCP client at `https://overwatch.example.com/mcp`.
2. The client discovers OAuth metadata (`/.well-known/oauth-protected-resource`
   and `/.well-known/oauth-authorization-server`), dynamically registers
   (RFC 7591), and opens the authorize URL — sign in with your Google admin
   account.
3. After sign-in Overwatch shows a consent page naming the client, the full
   redirect URI it will be sent back to, and the scope (`tenants`). Choose **Approve** or
   **Deny**; no authorization code is issued until you approve.
4. The client receives an access token (default 1h) + a rotating refresh token
   (default 30d) and calls tools. `update_tenant` streams progress notifications
   as it pulls the image, regenerates config, and recreates containers.

## Security notes

- OAuth 2.1 with PKCE (S256) is required; redirect URIs are exact-matched against
  the dynamically-registered client.
- Access tokens are scoped to the `/mcp` audience, distinct from the web-UI
  session token.
- Auth codes are single-use, 60s-lived, and held in memory — Overwatch assumes a
  single-process deployment per host.
- The OAuth endpoints are rate-limited per IP (20 requests a minute), and
  dynamic client registration (`POST /oauth/register`) has its own, smaller
  budget of 10 registrations per 10 minutes per IP.
- **Audit log.** Consent approvals and denials, refused sign-ins, token
  issuance at the code exchange, refreshes, revocations and refresh-token
  reuse are written to `data/audit.log` (no token values).
- **Consent.** The consent form carries a signed, single-use, 5-minute token that
  is only handed to the admin who just signed in with Google, so a forged
  cross-site request cannot approve a client. The page is not frameable
  (`X-Frame-Options: DENY`) and every client-supplied value is HTML-escaped.
  Only approve connections you started yourself.
- **Registration limits.** `redirect_uris` must be `https://` URLs or `http://`
  loopback URLs (`127.0.0.1`, `localhost`, `[::1]`, any port), without
  credentials or fragments; at most 10 per client. `client_name` is at most 100
  characters. At most 200 clients can be registered (further registrations get
  HTTP 429), and clients unused for 90 days are pruned together with their
  refresh tokens. Clients registered earlier with a non-loopback `http://`
  redirect URI keep working but the consent page warns about them; re-register
  them with `https://` redirects.
- **Token endpoint.** `client_id` is required for both the code exchange and
  the refresh grant and must match the client the code or refresh token was
  issued to (a refresh token presented by another client is revoked). A
  `resource` parameter, if sent, must be `<public_url>/mcp`; anything else is
  rejected with `invalid_target`. `expires_in` reflects `access_token_ttl`.
- **Refresh token rotation.** Every refresh returns a new refresh token and
  retires the old one. All tokens descending from one sign-in form a family:
  presenting a retired token again (more than 10 seconds after it was
  rotated) is treated as theft, revokes the whole family and is written to the
  audit log, so the client has to sign in again. A refresh is also refused when
  the grant is older than the admin's current entry in `admin-users.json`, so
  removing an admin and adding them back does not revive their old MCP grants.
  Refresh tokens issued before this check existed are accepted once and then
  rotate into a family.
- **Store hygiene.** Expired auth codes and refresh tokens are swept every 10
  minutes from `data/mcp-oauth.json`.

See `docs/superpowers/specs/2026-06-01-overwatch-mcp-oauth-design.md` for the full
design and `docs/superpowers/plans/2026-06-01-overwatch-mcp-oauth.md` for the
implementation plan.
