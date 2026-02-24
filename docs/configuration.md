# Configuration Reference

Overwatch separates **infrastructure config** (YAML, set at deployment) from **app config** (GUI/API, set at runtime).

## `overwatch.yaml` — Infrastructure Config

### Project Configuration

```yaml
project:
  name: string          # Display name (shown in UI)
  prefix: string        # Container naming prefix
  db_prefix: string     # Database/user naming prefix
```

**Naming conventions:**
- Containers: `{prefix}-{appId}-{tenantId}-{service}` (e.g., `myapp-app1-acme-backend`)
- Databases: `{db_prefix}_{tenantId}` (e.g., `myapp_acme`)
- Users: `{db_prefix}_{tenantId}` (e.g., `myapp_acme`)

### Database Configuration

```yaml
database:
  type: "mysql" | "mariadb" | "postgres"
  host: string                    # Database server hostname
  port: number                    # Default: 3306 (MySQL) or 5432 (Postgres)
  root_user: string               # Default: "root"
  root_password_env: string       # Environment variable name for root password
  container_name: string          # Docker container name (for dumps via docker exec)
```

### Networking Configuration

```yaml
networking:
  external_network: string        # Shared Docker network name
  apps_path: string               # Directory where app/tenant configs are stored
  internal_network_template: string  # Template for tenant networks (default: "${prefix}-${tenantId}-internal")
  cert_resolvers:                 # Traefik TLS cert resolver names (optional)
    wildcard: string              # Resolver for wildcard/DNS-challenge domains (default: "letsencrypt")
    default: string               # Resolver for non-wildcard/HTTP-challenge domains (default: "letsencrypt-http")
```

### Credentials Configuration

```yaml
credentials:
  db_password_length: number      # Auto-generated DB password length (default: 32)
  jwt_secret_length: number       # Auto-generated JWT secret length (default: 64)
```

These are project-wide defaults. Apps can override these per-app.

### Monitoring Configuration

```yaml
monitoring:
  enabled: boolean                # Enable container monitoring (default: true)
  metrics_interval: number        # Metrics collection interval in seconds (default: 15)
  metrics_retention: number       # Metrics retention period in seconds (default: 3600)
```

### Alert Rules

```yaml
alert_rules:
  - id: string                    # Unique rule ID
    name: string                  # Display name
    condition:
      type: "container_down" | "cpu_threshold" | "memory_threshold" | "health_check_failed"
      duration: string            # How long condition must persist (e.g., "3m", "5m")
      threshold: number           # CPU/memory percentage threshold
      consecutive_failures: number # Health check failure count
    cooldown: string              # Min time between repeated alerts (default: "15m")
    severity: "info" | "warning" | "critical"  # Default: "warning"
```

### Retention Configuration

```yaml
retention:
  max_alert_entries: number       # Max alert history entries (default: 10000)
  max_audit_entries: number       # Max audit log entries (default: 10000)
```

Log files are pruned on startup and hourly.

### Full Example

```yaml
project:
  name: "MyApp"
  prefix: "myapp"
  db_prefix: "myapp"

database:
  type: "mariadb"
  host: "myapp-mariadb"
  port: 3306
  root_user: "root"
  root_password_env: "MYSQL_ROOT_PASSWORD"
  container_name: "myapp-mariadb"

networking:
  external_network: "myapp-network"
  apps_path: "/app/apps"
  cert_resolvers:
    wildcard: "letsencrypt-cf"      # e.g., Cloudflare DNS challenge resolver
    default: "letsencrypt"          # e.g., HTTP challenge resolver

monitoring:
  enabled: true
  metrics_interval: 15

retention:
  max_alert_entries: 10000
  max_audit_entries: 10000
```

---

## App Definition — GUI/API Config

Apps are created and managed through the web UI or API (`POST /api/apps`). Each app defines its own registry, services, backup, and admin access settings. Apps are stored in `data/apps.json`.

### App Schema

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
    "auth": {
      "type": "token",
      "token_env": "GHCR_TOKEN",
      "username_env": "GHCR_USERNAME"
    }
  },
  "services": [
    {
      "name": "backend",
      "required": true,
      "ports": { "internal": 3000 },
      "health_check": { "type": "http", "path": "/health", "port": 3000, "tool": "curl" }
    },
    {
      "name": "migrator",
      "is_init_container": true
    }
  ],
  "backup": {
    "enabled": true,
    "schedule": "0 2 * * *",
    "provider": "s3",
    "s3": {
      "endpoint_env": "S3_ENDPOINT",
      "bucket_env": "S3_BUCKET",
      "access_key_env": "S3_ACCESS_KEY",
      "secret_key_env": "S3_SECRET_KEY"
    }
  },
  "admin_access": {
    "enabled": true,
    "url_template": "https://${domain}/admin-login?token=${token}",
    "secret_env": "AUTH_SERVICE_SECRET"
  }
}
```

### Services

Each service in an app defines a container that gets deployed per tenant:

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Service name — also used as the image name in the registry |
| `image_suffix` | No | Override image name if it differs from service name |
| `required` | No | Must be running for tenant to be "healthy" (default: false) |
| `is_init_container` | No | One-time setup container, e.g. migrations (default: false) |
| `ports.internal` | No | Container port |
| `ports.external` | No | Host-mapped port |
| `health_check` | No | HTTP or TCP health check config |
| `health_check.tool` | No | Binary to use for HTTP healthchecks: `"wget"` (default) or `"curl"` |
| `routing.strip_prefix` | No | Add Traefik StripPrefix middleware for `path_prefix` routes (default: false) |
| `command` | No | Override container command |
| `env_mapping` | No | Map environment variables to container vars |
| `depends_on` | No | Other service names this service depends on |

**Registry configuration per app:**

| Registry | Type | Auth Type | Required Env Vars |
|----------|------|-----------|-------------------|
| GHCR | `ghcr` | `token` | `GHCR_TOKEN` (PAT with `read:packages`) |
| Docker Hub | `dockerhub` | `basic` | `DOCKER_USERNAME`, `DOCKER_PASSWORD` |
| AWS ECR | `ecr` | `aws_iam` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` |
| Custom | `custom` | `token` or `basic` | Varies |

---

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `JWT_SECRET` | Secret for Overwatch session tokens |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID for admin login |

### Database (name from config)

| Variable | Description |
|----------|-------------|
| `MYSQL_ROOT_PASSWORD` | MySQL/MariaDB root password |
| `POSTGRES_PASSWORD` | PostgreSQL superuser password |

### Registry (name from app config)

| Variable | Description |
|----------|-------------|
| `GHCR_TOKEN` | GitHub Personal Access Token (GHCR) |
| `DOCKER_USERNAME` | Docker Hub username |
| `DOCKER_PASSWORD` | Docker Hub password/token |
| `AWS_ACCESS_KEY_ID` | AWS access key (ECR) |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key (ECR) |
| `AWS_REGION` | AWS region (ECR) |

### Backup (optional, from app config)

| Variable | Description |
|----------|-------------|
| `S3_ENDPOINT` | S3 endpoint URL |
| `S3_BUCKET` | S3 bucket name |
| `S3_ACCESS_KEY` | S3 access key |
| `S3_SECRET_KEY` | S3 secret key |
| `RESTIC_PASSWORD` | Restic encryption password |

### Admin Access (optional, from app config)

| Variable | Description |
|----------|-------------|
| `AUTH_SERVICE_SECRET` | JWT secret for tenant access tokens |

### Other

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3002` | Overwatch HTTP port |
| `ALLOWED_ADMIN_EMAILS` | (none) | Comma-separated initial admin emails |
