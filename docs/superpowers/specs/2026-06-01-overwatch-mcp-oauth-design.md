# Overwatch MCP Server with OAuth2 — Design

**Date:** 2026-06-01
**Status:** Approved (design); pending implementation plan
**Author:** Jiri Havlicek (with Claude)

## Summary

Add a remote **Model Context Protocol (MCP)** server to Overwatch so AI clients
(Claude Desktop/Code, etc.) can manage tenants over the network. The MCP endpoint
is served by the existing Express app and secured with **OAuth 2.1**, where
Overwatch acts as its own Authorization Server — delegating the human login step
to the existing Google sign-in and reusing the existing `admin-users.json` RBAC.

Version 1 exposes read tools (list apps, list tenants, get tenant) and write tools
(update tenant, start/stop/restart tenant). The long-running tenant update streams
its existing progress steps as MCP progress notifications.

## Goals

- Remote MCP server reachable by network MCP clients (Streamable HTTP transport).
- OAuth2-secured, with Overwatch issuing and managing its own access/refresh tokens.
- Reuse existing identity (Google sign-in) and authorization (`admin-users.json`
  roles: admin > editor > viewer).
- Expose tenant read + update + lifecycle tools, wrapping existing service logic.
- Live progress for tenant updates.
- Feature is **opt-in** (disabled by default) and mounts zero new routes when off.

## Non-Goals (v1)

- Local stdio MCP transport (remote HTTP only).
- Exposing every Overwatch capability (env-vars, backups, monitoring, traefik,
  admin-user management) — only the tenant tools listed below.
- Granular per-tool OAuth scopes — authorization is by existing role only.
- Multi-process / clustered deployment of the OAuth code store (single-appliance
  process assumed; see Assumptions).
- A consent screen beyond the existing Google sign-in + admin check.

## Decisions (from brainstorming)

| Decision | Choice |
|----------|--------|
| Transport / deployment | Remote Streamable HTTP, served by the existing Express app |
| OAuth2 model | Overwatch is its own Authorization Server |
| Human login | Delegated to the existing Google sign-in |
| Authorization | Reuse `admin-users.json` roles directly (no new scopes) |
| Tool scope | list apps & tenants, get tenant, update tenant, start/stop/restart |
| Long-running update | Synchronous call + MCP progress notifications |

## Context (existing code reused)

- Express app entry: `src/index.ts` (port from `PORT`, default 3002).
- Tenant update: `updateTenant(rawAppId, rawTenantId, newTag)` in
  `src/services/tenant.ts:334`. Handles validation, manifest sync, config
  regeneration, image pull, container recreate, rollback, and emits
  `tenant:update:progress` via `eventBus`.
- Tenant lifecycle (start/stop/restart) and tenant/app reads: `src/services/`.
- Auth today: Google OAuth credential → JWT (HS256, `JWT_SECRET`), verified by
  `src/middleware/auth.ts`, which **re-checks** admin membership on every request.
- RBAC: `requireRole(min)` in `src/middleware/requireRole.ts`; roles resolved via
  `src/services/users.ts` (`isAdminEmail`, `can(role, min)`); store is
  `data/admin-users.json`.
- Progress today goes to the web UI over WebSocket (`src/websocket/server.ts`)
  fed by `eventBus`.
- Audit logging middleware: `src/middleware/audit.ts`.

### SDK findings (current MCP TypeScript SDK)

- Resource-server helpers (`requireBearerAuth`, `mcpAuthMetadataRouter`,
  `OAuthTokenVerifier`) are provided by `@modelcontextprotocol/express`.
- Authorization-server helpers (`mcpAuthRouter`, `ProxyOAuthServerProvider`) have
  been **removed** from the core SDK — the AS endpoints are implemented in this
  project (Approach A).
- Tool handlers can send `notifications/progress` during a call when the request
  carries a `progressToken` in metadata.

> Exact package names/versions (`@modelcontextprotocol/sdk`,
> `@modelcontextprotocol/express`, and any `@modelcontextprotocol/server`) are
> pinned during the implementation-plan step against the published packages.

## Architecture

Three new concerns, all mounted into the existing Express app — no separate
process or port. Mounting is gated on `config.mcp.enabled`.

1. **OAuth 2.1 Authorization Server** — new routes + a small service/store layer.
   Delegates login to the existing Google sign-in; issues Overwatch-signed tokens.
2. **MCP Resource Server** — a Streamable HTTP MCP endpoint at `/mcp`, protected
   by bearer-token auth.
3. **MCP tools** — thin wrappers over existing `services/` functions.

### Module layout

```
src/oauth/
  store.ts        # JSON-backed stores: registered clients, refresh tokens (hashed),
                  # auth codes (in-memory); persisted file: data/mcp-oauth.json
  tokens.ts       # issue/verify MCP access tokens (JWT), refresh-token rotation
  metadata.ts     # build RFC 8414 (AS) + RFC 9728 (protected resource) metadata
src/routes/
  oauth.ts        # /oauth/authorize, /oauth/token, /oauth/register, /oauth/revoke
                  # + Google login delegation on the authorize endpoint
src/mcp/
  server.ts       # build McpServer, mount Streamable HTTP transport at /mcp
  auth.ts         # OAuthTokenVerifier -> {email, role} via admin-users
  tools/
    read.ts       # list_apps, list_tenants, get_tenant
    update.ts     # update_tenant (sync + progress)
    lifecycle.ts  # start_tenant, stop_tenant, restart_tenant
```

Wiring added to `src/index.ts`; config added to `src/config/schema.ts`.

### Boundary decisions

- Tools never re-implement logic — `update_tenant` calls `updateTenant()` as-is;
  lifecycle and read tools call the corresponding existing services.
- The OAuth AS is self-contained in `src/oauth/`; the rest of the app only consumes
  its issued tokens.
- The token verifier re-checks `admin-users.json` on every request (mirroring
  `src/middleware/auth.ts`), so removing a user revokes MCP access immediately.

## OAuth 2.1 Authorization Server

### Endpoints

- `GET /.well-known/oauth-protected-resource` (RFC 9728) — points to the AS.
- `GET /.well-known/oauth-authorization-server` (RFC 8414) — AS metadata
  (authorization/token/registration endpoints, PKCE S256 support, etc.).
- `POST /oauth/register` (RFC 7591 Dynamic Client Registration) — MCP clients
  self-register; returns a `client_id`. Clients are **public** (PKCE-only, no
  client secret). Registered `redirect_uri`s are stored for exact-match validation.
- `GET /oauth/authorize` — authorization-code flow with PKCE. Delegates to the
  existing Google sign-in; on success validates the email via `isAdminEmail()`.
  **Non-admins are denied** with a clear page. For admins, mints a single-use,
  ~60s auth code bound to the PKCE challenge, redirect_uri, resolved role, and
  requested resource; redirects back to the client with `code` and `state`.
- `POST /oauth/token` — exchanges `authorization_code` (with PKCE `code_verifier`)
  or `refresh_token` for tokens. Re-validates admin membership before issuing.
- `POST /oauth/revoke` (RFC 7009) — revokes a refresh token.

### Connection flow (first connect)

1. Client calls `/mcp` with no token → `401` +
   `WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource"`.
2. Client fetches protected-resource metadata → AS is Overwatch → fetches AS metadata.
3. Client self-registers at `POST /oauth/register` → `client_id`.
4. Client opens `GET /oauth/authorize?response_type=code&client_id=…&redirect_uri=…&code_challenge=…&code_challenge_method=S256&state=…&resource=…`.
5. Overwatch runs Google sign-in → checks admin → mints auth code → redirects back.
6. Client exchanges code at `POST /oauth/token` (with `code_verifier`) → access
   token (JWT) + refresh token.
7. Client retries `/mcp` with `Authorization: Bearer <jwt>` → authorized.

### Token management

- **Access token** — JWT signed with the existing `JWT_SECRET` (HS256), default
  TTL 1h. Claims: `sub`=email, `role`, `iss`=`config.mcp.public_url`,
  `aud`=the `/mcp` resource URL, `scope`, plus standard `iat`/`exp`. The distinct
  `aud` keeps MCP tokens and the 24h web-UI token from being used interchangeably.
- **Refresh token** — opaque random string, stored **hashed** in
  `data/mcp-oauth.json`, default TTL 30d, **rotated** on each use (previous token
  invalidated; reuse of a rotated token is rejected).
- **Registered clients** — persisted in `data/mcp-oauth.json`.
- **Auth codes** — in-memory map, ~60s TTL, single-use.
- **Revocation** — both `/oauth/token` and every MCP request re-validate admin
  membership, so deleting a user revokes access immediately regardless of
  unexpired tokens. `/oauth/revoke` additionally invalidates a refresh token.

### Security specifics

- PKCE (S256) required on all authorization-code flows.
- `redirect_uri` exact-match against the registered client.
- `state` passed through unchanged.
- Auth codes single-use and short-lived; replay and expiry rejected.
- OAuth error responses follow RFC 6749 error format.
- Tokens validated for signature, `exp`, `iss`, and `aud` on every request.

## MCP Resource Server, Tools & Role Gating

### Transport & auth

Streamable HTTP MCP server mounted at `/mcp` (POST for requests, GET for the SSE
stream), wrapped by `requireBearerAuth` using a custom `OAuthTokenVerifier`
(`src/mcp/auth.ts`) that verifies the JWT, confirms `aud`, and re-resolves the
current role from `admin-users.json`, attaching `{ email, role }` to the request
auth context.

### Tools

| Tool | Inputs | Min role | Wraps |
|------|--------|----------|-------|
| `list_apps` | — | viewer | `src/services/app.ts` |
| `list_tenants` | `appId` | viewer | `src/services/tenant.ts` |
| `get_tenant` | `appId`, `tenantId` | viewer | tenant read |
| `update_tenant` | `appId`, `tenantId`, `imageTag` | editor | `updateTenant()` |
| `start_tenant` | `appId`, `tenantId` | editor | lifecycle service |
| `stop_tenant` | `appId`, `tenantId` | editor | lifecycle service |
| `restart_tenant` | `appId`, `tenantId` | editor | lifecycle service |

- Inputs validated with Zod, reusing the slug/tag validators already used by the
  services.
- Role enforced inside each handler from the auth context (mirroring the REST
  `requireRole` gates). A failed role check returns an MCP tool error
  (`isError: true`) with a clear "requires <role> role" message — not a
  protocol-level crash.

### `update_tenant` progress (synchronous + notifications)

- Handler reads the incoming `progressToken` from request metadata.
- Subscribes to `eventBus` `tenant:update:progress` filtered to this
  `appId`/`tenantId`; forwards each step (e.g. pulling image, regenerating config,
  recreating containers) as an MCP `notifications/progress` message.
- `await`s `updateTenant()` to completion, unsubscribes, returns a final text
  result (new tag + success). On throw, returns an `isError` result with the
  failure detail (the service handles rollback internally).
- The subscription is always torn down (success or failure) to avoid listener
  leaks; concurrent updates are distinguished by `appId`/`tenantId`.

### Audit

MCP write actions (update + lifecycle) route through the same audit logging the
REST endpoints use, tagged with the authenticated email and `source: "mcp"`, so
MCP-initiated changes appear in the existing audit log.

## Configuration

New optional `mcp` section in `src/config/schema.ts`, all with safe defaults:

```yaml
mcp:
  enabled: false              # opt-in; when false, no /mcp or /oauth routes mount
  public_url: ""              # issuer / base URL for OAuth metadata + token aud
                              # (e.g. https://overwatch.example.com)
  access_token_ttl: "1h"
  refresh_token_ttl: "30d"
```

- When `enabled` is false, none of the `/mcp` or `/oauth/*` routes mount.
- `public_url` is **required when enabled** (metadata + audiences must be absolute,
  externally reachable URLs). Startup validation fails fast with a clear message
  if it is missing while `enabled` is true.
- `JWT_SECRET` and `GOOGLE_CLIENT_ID` (already required by the app) are reused.

## Error Handling

- **Auth:** `401` with a correct `WWW-Authenticate` header for missing/expired/
  wrong-audience tokens; OAuth endpoint errors in RFC 6749 format; non-admin login
  denied at the authorize step with a clear page.
- **Tools:** validation errors and role denials return tool error results
  (`isError: true`) with safe messages. Unexpected exceptions are caught and
  returned as a generic failure message only — never leak file paths or stack
  traces.
- Existing service-level validation (slug/tag, symlink defense, rollback) is
  relied upon and not duplicated.

## Testing (vitest)

### Unit

- Token issue/verify: valid, expired, wrong `aud`, tampered signature.
- PKCE S256 verification: correct verifier accepted, incorrect rejected.
- Dynamic client registration: client created; `redirect_uri` exact-match.
- Refresh-token rotation: rotated token works once; reuse of the old token rejected.
- Metadata documents: AS + protected-resource shapes correct.
- Per-tool role gating: viewer denied writes, editor allowed writes/lifecycle, etc.

### Integration

- Full `authorize → token → /mcp` flow with Google verification mocked.
- Each tool with its underlying service mocked.
- `update_tenant` progress forwarding: emit fake `eventBus` steps, assert
  `notifications/progress` messages sent and a final result returned.
- Non-admin denied at the authorize step.
- Revocation: user removed from `admin-users.json` → subsequent MCP request rejected.

### Negative / security

- Missing / expired / wrong-audience token → `401`.
- Insufficient role → tool error.
- Auth code replay rejected; expired auth code rejected.
- Rotated refresh token reuse rejected.

## Deployment Notes

- `/mcp` and `/oauth/*` must be reachable through Traefik on the public host.
- The in-memory auth-code store assumes the documented single-process appliance
  model; see Assumptions.

## Assumptions

- Overwatch runs as a single process per host (no horizontal scaling), so the
  in-memory auth-code store is acceptable. Refresh tokens and clients are file-
  persisted and survive restarts; in-flight auth codes do not (a client simply
  restarts the short authorize flow).
- The existing Google sign-in remains the sole human-identity source; MCP adds no
  new identity provider.

## Rollback

- The feature is opt-in via `config.mcp.enabled`. Disabling it (or removing the
  config section) unmounts all MCP/OAuth routes with no effect on existing
  REST/UI/CLI behavior.
- New files are additive; the only edits to existing files are the config schema
  addition and the route-mounting block in `src/index.ts`, both guarded by the
  enabled flag.

## Open Questions (resolve during planning)

- Exact MCP SDK package set and versions, and whether `@modelcontextprotocol/express`
  fully covers Streamable HTTP mounting or whether the lower-level transport from
  `@modelcontextprotocol/sdk` is used directly.
- How the authorize endpoint renders Google sign-in (reuse the existing UI login
  page vs. a minimal dedicated consent/login page served by the OAuth route).
