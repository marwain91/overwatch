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
- Containers: `{appId}-{tenantId}-{service}` (e.g., `myapp-acme-backend`)
- Databases: `{db_prefix}_{appId}_{tenantId}` (e.g., `myapp_myapp_acme`)
- Users: `{db_prefix}_{appId}_{tenantId}` (e.g., `myapp_myapp_acme`)

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
      "health_check": { "type": "http", "path": "/health", "port": 3000, "tool": "curl", "start_period": "30s" },
      "routing": { "path_prefix": "/api", "additional_path_prefixes": ["/uploads"], "priority": 10 },
      "env_mapping": { "DB_HOST": "DB_HOST", "NODE_ENV": "NODE_ENV" },
      "volumes": [{ "name": "uploads", "container_path": "/app/uploads", "name_template": "${appId}-${tenantId}-uploads", "external": true }],
      "networks": ["external", "internal"],
      "depends_on": ["migrator"]
    },
    {
      "name": "migrator",
      "is_init_container": true,
      "user": "root",
      "command": ["sh", "-c", "npm run db:migrate"],
      "networks": ["external"]
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
| `is_init_container` | No | One-time setup container, e.g. migrations (default: false). Gets `restart: "no"` |
| `user` | No | Run container as specific user (e.g. `"root"`) |
| `ports.internal` | No | Container port |
| `ports.external` | No | Host-mapped port |
| `health_check` | No | HTTP or TCP health check config |
| `health_check.tool` | No | Binary to use for HTTP healthchecks: `"wget"` (default) or `"curl"` |
| `health_check.start_period` | No | Grace period before health checks count (e.g. `"30s"`) |
| `command` | No | Override container command |
| `env_mapping` | No | Map environment variables to container vars |
| `routing.path_prefix` | No | Traefik path prefix for routing (e.g. `"/api"`) |
| `routing.additional_path_prefixes` | No | Extra path prefixes combined with OR (e.g. `["/uploads"]`) |
| `routing.priority` | No | Traefik router priority |
| `routing.strip_prefix` | No | Add Traefik StripPrefix middleware for path_prefix routes (default: false) |
| `volumes[].name` | No | Volume name |
| `volumes[].container_path` | No | Mount path inside container |
| `volumes[].name_template` | No | Template for volume name with `${appId}` and `${tenantId}` substitution |
| `volumes[].external` | No | Declare volume as external (default: false) |
| `depends_on` | No | Other service names this service depends on |
| `networks` | No | Network list: `["external"]` (default), `["external", "internal"]`, or `["internal"]` |

### `env_mapping` — Environment Variable Mapping

Maps environment variable names inside the container to their resolved values. Values are resolved in three modes:

| Mode | Syntax | Behavior |
|------|--------|----------|
| Auto-resolved | `"DB_HOST": "DB_HOST"` | Known variable names are resolved at compose generation time to literal values from config/context |
| `${VAR}` fallback | `"CUSTOM_KEY": "CUSTOM_KEY"` | Unknown variable names produce `${VAR}` for Docker Compose interpolation from `.env` |
| Static | `"DB_HOST": { "static": "custom-db" }` | Always emits the literal value as-is |

**Auto-resolvable variable names:**

| Source name | Resolves to |
|---|---|
| `DB_HOST` | `config.database.host` |
| `DB_PORT` | `config.database.port` |
| `FRONTEND_URL` | `https://{tenant domain}` |
| `BACKEND_URL` | `https://{tenant domain}` |
| `PORT` | `service.ports.internal` (falls back to `${PORT}` if no ports defined) |
| `BACKEND_PORT` | Same as `PORT` |
| `NODE_ENV` | `"production"` |

> **Warning:** Do not put variables that already exist in `shared.env` into `env_mapping`. The explicit `environment:` block in docker-compose overrides values from `env_file`, so the `shared.env` value would be ignored.

**Example config:**

```json
"env_mapping": {
  "DB_HOST": "DB_HOST",
  "DB_PORT": "DB_PORT",
  "FRONTEND_URL": "FRONTEND_URL",
  "NODE_ENV": "NODE_ENV",
  "CUSTOM_SECRET": "MY_SECRET",
  "REDIS_HOST": { "static": "redis-server" }
}
```

**Generated output** (assuming `database.host: "myapp-mariadb"`, `database.port: 3306`, tenant domain `acme.myapp.com`):

```yaml
environment:
  DB_HOST: "myapp-mariadb"
  DB_PORT: "3306"
  FRONTEND_URL: "https://acme.myapp.com"
  NODE_ENV: "production"
  CUSTOM_SECRET: "${MY_SECRET}"
  REDIS_HOST: "redis-server"
```

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
