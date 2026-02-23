# API Reference

All API endpoints require authentication via Bearer token (except `/api/auth/*` and `/health`).

## Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/auth/google` | Login with Google OAuth credential |
| `GET` | `/api/auth/verify` | Verify current JWT token |
| `GET` | `/api/auth/config` | Get Google Client ID for frontend |

## Apps

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/apps` | List all apps |
| `POST` | `/api/apps` | Create new app |
| `GET` | `/api/apps/:appId` | Get app details |
| `PUT` | `/api/apps/:appId` | Update app configuration |
| `DELETE` | `/api/apps/:appId` | Delete app (query `?force=true` to force) |
| `GET` | `/api/apps/:appId/tags` | List available image tags from registry |
| `POST` | `/api/apps/:appId/registry/test` | Test registry connection |

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

## Tenants

All tenant endpoints are scoped to an app: `/api/apps/:appId/tenants`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/apps/:appId/tenants` | List tenants for app |
| `POST` | `/api/apps/:appId/tenants` | Create new tenant |
| `PATCH` | `/api/apps/:appId/tenants/:tenantId` | Update tenant version |
| `DELETE` | `/api/apps/:appId/tenants/:tenantId` | Delete tenant |
| `POST` | `/api/apps/:appId/tenants/:tenantId/start` | Start tenant containers |
| `POST` | `/api/apps/:appId/tenants/:tenantId/stop` | Stop tenant containers |
| `POST` | `/api/apps/:appId/tenants/:tenantId/restart` | Restart tenant containers |
| `POST` | `/api/apps/:appId/tenants/:tenantId/access-token` | Generate admin access URL |

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

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/apps/:appId/backups/summary` | Backup summary (status, schedule, last backup, snapshot count) |
| `GET` | `/api/apps/:appId/backups/status` | Backup system status |
| `POST` | `/api/apps/:appId/backups/init` | Initialize backup repository |
| `POST` | `/api/apps/:appId/backups/unlock` | Unlock stale repository locks |
| `GET` | `/api/apps/:appId/backups` | List all snapshots |
| `POST` | `/api/apps/:appId/backups` | Create backup for tenant |
| `POST` | `/api/apps/:appId/backups/all` | Backup all tenants |
| `POST` | `/api/apps/:appId/backups/:snapshotId/restore` | Restore to existing tenant |
| `POST` | `/api/apps/:appId/backups/:snapshotId/create-tenant` | Create new tenant from backup |
| `DELETE` | `/api/apps/:appId/backups/:snapshotId` | Delete snapshot |
| `POST` | `/api/apps/:appId/backups/prune` | Prune old backups |

**Create backup request:**
```json
{
  "tenantId": "acme"
}
```

## Environment Variables

All env var endpoints are scoped to an app: `/api/apps/:appId/env-vars`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/apps/:appId/env-vars` | List global environment variables |
| `POST` | `/api/apps/:appId/env-vars` | Create or update a global variable |
| `DELETE` | `/api/apps/:appId/env-vars/:key` | Delete a global variable |
| `GET` | `/api/apps/:appId/env-vars/tenants/:tenantId` | Get effective variables for a tenant |
| `POST` | `/api/apps/:appId/env-vars/tenants/:tenantId/overrides` | Set a tenant-specific override |
| `DELETE` | `/api/apps/:appId/env-vars/tenants/:tenantId/overrides/:key` | Remove a tenant override |

## Status & Containers

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/status/health` | System health overview |
| `GET` | `/api/status/backup-summaries` | Backup summaries for all apps |
| `GET` | `/api/status/config` | Get project configuration |
| `GET` | `/api/status/tenants` | List all tenants across all apps |
| `GET` | `/api/status/containers` | List managed containers |
| `GET` | `/api/status/containers/:id/logs` | Get container logs |
| `POST` | `/api/status/containers/:id/restart` | Restart specific container |

## Monitoring

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/monitoring/metrics` | Current metrics snapshot |
| `GET` | `/api/monitoring/metrics/:appId/:tenantId` | Metrics for a specific tenant |
| `GET` | `/api/monitoring/metrics/history/:containerName` | Metrics history for a container |
| `GET` | `/api/monitoring/health` | Health check states |
| `GET` | `/api/monitoring/alerts` | Alert history |
| `GET` | `/api/monitoring/alerts/rules` | Configured alert rules |
| `GET` | `/api/monitoring/notifications` | List notification channels |
| `POST` | `/api/monitoring/notifications` | Create notification channel |
| `PUT` | `/api/monitoring/notifications/:id` | Update notification channel |
| `DELETE` | `/api/monitoring/notifications/:id` | Delete notification channel |
| `POST` | `/api/monitoring/notifications/:id/test` | Send test notification |

## Admin Users

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/admin-users` | List admin users |
| `POST` | `/api/admin-users` | Add admin user |
| `DELETE` | `/api/admin-users/:email` | Remove admin user |

## Audit Logs

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/audit-logs` | List recent audit log entries (default 50, max 200) |

Query parameters: `?limit=50&user=email&action=create`

## Health Check

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Simple health check (no auth) |

## WebSocket

Connect to `/ws` with a Bearer token for real-time updates:

- `metrics:snapshot` — periodic container metrics
- `container:event` — Docker start/stop/die events
- `health:change` — health state transitions
- `alert:fired` / `alert:resolved` — alert events
