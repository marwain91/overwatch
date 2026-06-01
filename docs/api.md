# API Reference

All API endpoints require authentication via an Overwatch JWT except `/api/auth/google`, `/api/auth/config`, and `/health`. `/api/auth/verify` is public at the router level but expects an `Authorization: Bearer <token>` header.

## Conventions

Minimum role values:

| Role | Meaning |
|------|---------|
| `public` | No Overwatch JWT required |
| `auth` | Any authenticated admin-panel user |
| `editor` | Editor or admin |
| `admin` | Admin only |

Destructive endpoints marked `confirm` require either an `X-Confirm-Id` header or a JSON `confirmId` field matching the route identifier. For example, `DELETE /api/apps/acme` requires `X-Confirm-Id: acme`.

## Authentication

| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| `POST` | `/api/auth/google` | `public` | Login with a Google OAuth credential and receive an Overwatch JWT |
| `GET` | `/api/auth/verify` | `public` + Bearer token | Verify the current Overwatch JWT |
| `GET` | `/api/auth/config` | `public` | Get Google Client ID and login configuration for the frontend |

## Apps

| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| `GET` | `/api/apps` | `auth` | List all active apps |
| `GET` | `/api/apps/.trashed` | `auth` | List soft-deleted apps |
| `POST` | `/api/apps` | `admin` | Create a new app |
| `GET` | `/api/apps/:appId` | `auth` | Get app details |
| `PUT` | `/api/apps/:appId` | `admin` | Update app configuration |
| `DELETE` | `/api/apps/:appId` | `admin`, `confirm` | Delete app; `?force=true` permits delete when tenants exist |
| `POST` | `/api/apps/:appId/restore` | `admin` | Restore a soft-deleted app |
| `DELETE` | `/api/apps/:appId/purge` | `admin`, `confirm` | Permanently purge a soft-deleted app |
| `GET` | `/api/apps/:appId/tags` | `auth` | List available image tags from registry; registry failures return `{ tags: [], error }` |
| `POST` | `/api/apps/:appId/registry/test` | `editor` | Test registry connection |
| `GET` | `/api/apps/:appId/traefik` | `auth` | Get app-scoped Traefik middleware/defaults |
| `PUT` | `/api/apps/:appId/traefik` | `editor` | Update app-scoped Traefik middleware/defaults |

**Create app request:**
```json
{
  "id": "myapp",
  "name": "My Application",
  "domain_template": "*.myapp.com",
  "default_image_tag": "latest",
  "registry": {
    "type": "ghcr",
    "url": "ghcr.io",
    "repository": "org/myapp",
    "auth": { "type": "token", "token_env": "GHCR_TOKEN" }
  },
  "services": [
    { "name": "backend", "required": true, "ports": { "internal": 3000 } }
  ]
}
```

The `registry` block accepts these auth shapes:

| Registry type | Auth type | Required `auth` fields | Notes |
|---|---|---|---|
| `ghcr` | `token` | `token_env` | PAT with `read:packages`; add `repo` when tag listing must inspect a private source repository |
| `gitlab` | `token` | `token_env` | Add top-level `api_url` for self-hosted; see [registry-gitlab.md](./registry-gitlab.md) |
| `dockerhub` | `basic` | `username_env`, `token_env` | Use a Docker Hub access token |
| `ecr` | `aws_iam` | `aws_region_env` plus standard AWS env | |
| `custom` | `token` or `basic` | varies | |

> **Note:** GitHub App auth (`auth.type: github_app`) was added in v1.6.x and removed in v1.6.7. GHCR's permission model only honors App tokens for public packages; for private/internal packages a PAT is required.

GitLab self-hosted example:
```json
"registry": {
  "type": "gitlab",
  "url": "registry.acme.com:5050",
  "api_url": "https://gitlab.acme.com",
  "repository": "group/sub/project",
  "auth": { "type": "token", "token_env": "GITLAB_TOKEN" }
}
```

## Tenants

All tenant endpoints are scoped to an app: `/api/apps/:appId/tenants`.

| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| `GET` | `/api/apps/:appId/tenants` | `auth` | List tenants for an app |
| `POST` | `/api/apps/:appId/tenants` | `editor` | Create a tenant |
| `PATCH` | `/api/apps/:appId/tenants/:tenantId` | `editor` | Update tenant image tag |
| `DELETE` | `/api/apps/:appId/tenants/:tenantId` | `admin`, `confirm` | Delete tenant; `?keepData=true` keeps generated data |
| `POST` | `/api/apps/:appId/tenants/:tenantId/start` | `editor` | Start tenant containers |
| `POST` | `/api/apps/:appId/tenants/:tenantId/stop` | `editor` | Stop tenant containers |
| `POST` | `/api/apps/:appId/tenants/:tenantId/restart` | `editor` | Restart tenant containers |
| `POST` | `/api/apps/:appId/tenants/:tenantId/access-token` | `admin` | Generate admin access URL/token |
| `GET` | `/api/apps/:appId/tenants/:tenantId/traefik` | `auth` | Get per-tenant Traefik overrides |
| `PUT` | `/api/apps/:appId/tenants/:tenantId/traefik` | `editor` | Update per-tenant Traefik overrides |

**Create tenant request:**
```json
{
  "tenantId": "acme",
  "domain": "acme.example.com",
  "imageTag": "v1.0.0"
}
```

**Update tenant request:**
```json
{
  "imageTag": "v1.1.0"
}
```

## Backups

All backup endpoints are scoped to an app: `/api/apps/:appId/backups`.

| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| `GET` | `/api/apps/:appId/backups/summary` | `auth` | Backup summary: status, schedule, last backup, snapshot count |
| `GET` | `/api/apps/:appId/backups/status` | `auth` | Backup system status |
| `POST` | `/api/apps/:appId/backups/init` | `admin` | Initialize backup repository |
| `POST` | `/api/apps/:appId/backups/unlock` | `admin` | Unlock stale repository locks |
| `GET` | `/api/apps/:appId/backups` | `auth` | List snapshots |
| `POST` | `/api/apps/:appId/backups` | `editor` | Create backup for a tenant |
| `POST` | `/api/apps/:appId/backups/all` | `editor` | Backup all tenants in an app |
| `POST` | `/api/apps/:appId/backups/:snapshotId/restore` | `admin` | Restore to an existing tenant |
| `POST` | `/api/apps/:appId/backups/:snapshotId/create-tenant` | `admin` | Create a new tenant from a backup |
| `DELETE` | `/api/apps/:appId/backups/:snapshotId` | `admin`, `confirm` | Delete a snapshot |
| `POST` | `/api/apps/:appId/backups/prune` | `admin` | Prune old backups |

**Create backup request:**
```json
{
  "tenantId": "acme"
}
```

## Environment Variables

All env var endpoints are scoped to an app: `/api/apps/:appId/env-vars`.

| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| `GET` | `/api/apps/:appId/env-vars` | `auth` | List global environment variables |
| `POST` | `/api/apps/:appId/env-vars` | `editor` | Create or update a global variable |
| `DELETE` | `/api/apps/:appId/env-vars/:key` | `editor` | Delete a global variable |
| `GET` | `/api/apps/:appId/env-vars/tenants/:tenantId` | `auth` | Get effective variables for a tenant |
| `POST` | `/api/apps/:appId/env-vars/tenants/:tenantId/overrides` | `editor` | Set a tenant-specific override |
| `DELETE` | `/api/apps/:appId/env-vars/tenants/:tenantId/overrides/:key` | `editor` | Remove a tenant override |

## Status & Containers

| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| `GET` | `/api/status/health` | `auth` | System health overview |
| `GET` | `/api/status/backup-summaries` | `auth` | Backup summaries for all apps |
| `GET` | `/api/status/config` | `auth` | Get project configuration |
| `GET` | `/api/status/tenants` | `auth` | List all tenants across all apps |
| `GET` | `/api/status/containers` | `auth` | List managed containers |
| `GET` | `/api/status/containers/:containerId/logs` | `auth` | Get container logs |
| `POST` | `/api/status/containers/:containerId/restart` | `admin` | Restart a specific container |

## Monitoring

| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| `GET` | `/api/monitoring/metrics` | `auth` | Current metrics snapshot |
| `GET` | `/api/monitoring/metrics/:appId/:tenantId` | `auth` | Metrics for a specific tenant |
| `GET` | `/api/monitoring/metrics/history/:containerName` | `auth` | Metrics history for a container |
| `GET` | `/api/monitoring/health` | `auth` | Health check states |
| `GET` | `/api/monitoring/alerts` | `auth` | Alert history |
| `GET` | `/api/monitoring/alerts/rules` | `auth` | Configured alert rules |
| `GET` | `/api/monitoring/notifications` | `auth` | List notification channels |
| `POST` | `/api/monitoring/notifications` | `admin` | Create notification channel |
| `PUT` | `/api/monitoring/notifications/:id` | `admin` | Update notification channel |
| `DELETE` | `/api/monitoring/notifications/:id` | `admin` | Delete notification channel |
| `POST` | `/api/monitoring/notifications/:id/test` | `admin` | Send test notification |

## Admin Users

| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| `GET` | `/api/admin-users` | `auth` | List admin users |
| `POST` | `/api/admin-users` | `admin` | Add admin user |
| `DELETE` | `/api/admin-users/:email` | `admin`, `confirm` | Remove admin user; URL-encode the email path segment |

## Audit Logs

| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| `GET` | `/api/audit-logs` | `auth` | List recent audit log entries, default 50 and max 200 |

Query parameters: `?limit=50&user=email&action=create`

## Database

| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| `GET` | `/api/database/info` | `auth` | Database adapter and connection information |
| `GET` | `/api/database/stats` | `auth` | Database-level stats |
| `GET` | `/api/database/databases` | `auth` | List tenant databases |
| `GET` | `/api/database/processes` | `auth` | List database processes |
| `POST` | `/api/database/processes/:id/kill` | `admin` | Kill a database process |

## Traefik

Global Traefik endpoints manage `overwatch.yaml.traefik`.

| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| `GET` | `/api/traefik` | `auth` | Get full Traefik configuration |
| `PUT` | `/api/traefik` | `admin` | Replace full Traefik configuration |
| `POST` | `/api/traefik/validate` | `auth` | Validate a Traefik configuration payload |
| `GET` | `/api/traefik/cert-resolvers` | `auth` | List cert resolvers |
| `POST` | `/api/traefik/cert-resolvers/:name` | `admin` | Create cert resolver |
| `PUT` | `/api/traefik/cert-resolvers/:name` | `admin` | Update cert resolver |
| `DELETE` | `/api/traefik/cert-resolvers/:name` | `admin`, `confirm` | Delete cert resolver |
| `GET` | `/api/traefik/middlewares` | `auth` | List global middlewares |
| `POST` | `/api/traefik/middlewares/:name` | `admin` | Create global middleware |
| `PUT` | `/api/traefik/middlewares/:name` | `admin` | Update global middleware |
| `DELETE` | `/api/traefik/middlewares/:name` | `admin`, `confirm` | Delete global middleware |
| `GET` | `/api/traefik/dashboard` | `auth` | Get dashboard router config |
| `PUT` | `/api/traefik/dashboard` | `admin` | Update dashboard router config |
| `GET` | `/api/traefik/overwatch` | `auth` | Get Overwatch admin router config |
| `PUT` | `/api/traefik/overwatch` | `admin` | Update Overwatch admin router config |
| `POST` | `/api/traefik/reload` | `admin` | Restart/reload Traefik so static config changes apply |

## OAuth 2.1 (MCP Server)

OAuth endpoints and metadata are only available when `mcp.enabled: true` in `overwatch.yaml`. Implements OAuth 2.1 with PKCE (S256 only). Access tokens are scoped to the `/mcp` audience (distinct from web-UI session tokens). Auth codes are single-use, 60 seconds-lived, and held in memory. Rate-limited at 20 req/min.

| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| `GET` | `/.well-known/oauth-authorization-server` | `public` | OAuth authorization server metadata (RFC 8414) |
| `GET` | `/.well-known/oauth-protected-resource` | `public` | OAuth protected resource metadata (RFC 8414) |
| `POST` | `/oauth/register` | `public` | Dynamic client registration (RFC 7591); returns `client_id`, `client_name`, `redirect_uris`, `token_endpoint_auth_method`, `grant_types`, `response_types` |
| `GET` | `/oauth/authorize` | `public` | Authorization endpoint; renders login page; requires PKCE S256 `code_challenge` + `code_challenge_method`, registered `client_id` and `redirect_uri` |
| `POST` | `/oauth/authorize/callback` | `public` | Callback after Google sign-in; mints single-use authorization code (60s, in-memory); requires valid Google ID token and admin email verified in `admin-users.json` |
| `POST` | `/oauth/token` | `public` | Token exchange; supports `grant_type: authorization_code` (with PKCE `code_verifier`) and `grant_type: refresh_token`; returns Bearer token with 3600s expiry |
| `POST` | `/oauth/revoke` | `public` | Revoke a refresh token; always returns 200 per RFC 7009 |
| `GET` | `/oauth/gsi-callback.js` | `public` | CSP-safe Google Identity Services callback script |

## MCP Server

The Model Context Protocol server at `/mcp` enables AI clients (Claude, etc.) to manage tenants. Available only when `mcp.enabled: true`. Requires Bearer token authentication (OAuth access token scoped to `/mcp` audience). Rate-limited at 60 req/min.

| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| `POST` | `/mcp` | `viewer` or higher | Stateless HTTP transport for MCP tool calls; request body is JSON-RPC 2.0; response streams via HTTP |
| `GET` | `/mcp` | — | Returns 405 Method Not Allowed (stateless mode has no standalone SSE stream) |

**MCP Tools:**

| Tool | Min Role | Description |
|------|----------|-------------|
| `list_apps` | `viewer` | List managed apps |
| `list_tenants` | `viewer` | List tenants (optionally for one app) |
| `get_tenant` | `viewer` | Get a tenant's current image tag and details |
| `update_tenant` | `editor` | Update a tenant to a new image tag (streams progress notifications) |
| `start_tenant` | `editor` | Start a tenant's containers |
| `stop_tenant` | `editor` | Stop a tenant's containers |
| `restart_tenant` | `editor` | Restart a tenant's containers |

Role authorization is checked per-request against the current `admin-users.json`; removing an admin revokes MCP access immediately.

## Health Check

| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| `GET` | `/health` | `public` | Simple liveness check |

## WebSocket

Connect to `/ws`, then send the first WebSocket message within 5 seconds:

```json
{ "type": "auth", "token": "<overwatch-jwt>" }
```

Events:

- `auth:ok` — authentication accepted
- `metrics:snapshot` — periodic container metrics
- `container:event` — Docker start/stop/die events
- `health:change` — health state transitions
- `alert:fired` / `alert:resolved` — alert events
- `tenant:update:progress` — tenant update progress steps
