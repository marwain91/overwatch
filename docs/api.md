# API Reference

All API endpoints require authentication via Bearer token (except `/api/auth/*` and `/health`).

## Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/auth/google` | Login with Google OAuth credential |
| `GET` | `/api/auth/verify` | Verify current JWT token |
| `GET` | `/api/auth/config` | Get Google Client ID for frontend |

## Tenants

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/tenants` | List all tenants |
| `POST` | `/api/tenants` | Create new tenant |
| `PATCH` | `/api/tenants/:tenantId` | Update tenant version |
| `DELETE` | `/api/tenants/:tenantId` | Delete tenant |
| `POST` | `/api/tenants/:tenantId/start` | Start tenant containers |
| `POST` | `/api/tenants/:tenantId/stop` | Stop tenant containers |
| `POST` | `/api/tenants/:tenantId/restart` | Restart tenant containers |
| `POST` | `/api/tenants/:tenantId/access-token` | Generate admin access URL |

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

## Status & Containers

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/status/health` | System health overview |
| `GET` | `/api/status/containers` | List managed containers |
| `GET` | `/api/status/containers/:id/logs` | Get container logs |
| `POST` | `/api/status/containers/:id/restart` | Restart specific container |
| `GET` | `/api/status/tags` | List available image tags |
| `GET` | `/api/status/config` | Get project configuration |

## Backups

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/backups/status` | Backup system status |
| `POST` | `/api/backups/init` | Initialize backup repository |
| `POST` | `/api/backups/unlock` | Unlock stale repository locks |
| `GET` | `/api/backups` | List all snapshots |
| `POST` | `/api/backups` | Create backup for tenant |
| `POST` | `/api/backups/all` | Backup all tenants |
| `POST` | `/api/backups/:snapshotId/restore` | Restore to existing tenant |
| `POST` | `/api/backups/:snapshotId/create-tenant` | Create new tenant from backup |
| `DELETE` | `/api/backups/:snapshotId` | Delete snapshot |
| `POST` | `/api/backups/prune` | Prune old backups |

**Create backup request:**
```json
{
  "tenantId": "acme"
}
```

**Create tenant from backup request:**
```json
{
  "tenantId": "acme-copy",
  "domain": "acme-copy.example.com",
  "imageTag": "v1.0.0"
}
```

## Environment Variables

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/env-vars` | List global environment variables |
| `POST` | `/api/env-vars` | Create or update a global variable |
| `DELETE` | `/api/env-vars/:key` | Delete a global variable |
| `GET` | `/api/env-vars/tenants/:tenantId` | Get effective variables for a tenant |
| `POST` | `/api/env-vars/tenants/:tenantId/overrides` | Set a tenant-specific override |
| `DELETE` | `/api/env-vars/tenants/:tenantId/overrides/:key` | Remove a tenant override |

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

## Health Check

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Simple health check (no auth) |
