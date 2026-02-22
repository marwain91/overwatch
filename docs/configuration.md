# Configuration Reference

## `overwatch.yaml` Schema

### Project Configuration

```yaml
project:
  name: string          # Display name (shown in UI)
  prefix: string        # Container naming prefix
  db_prefix: string     # Database/user naming prefix
```

**Naming conventions:**
- Containers: `{prefix}-{tenantId}-{service}` (e.g., `myapp-acme-backend`)
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

### Registry Configuration

```yaml
registry:
  type: "ghcr" | "dockerhub" | "ecr" | "custom"
  url: string                     # Registry URL
  repository: string              # Repository path (org/repo)
  auth:
    type: "token" | "basic" | "aws_iam"
    token_env: string             # For token auth: env var with PAT
    username_env: string          # For basic auth: env var with username
    aws_region_env: string        # For ECR: env var with AWS region
```

**Registry-specific configuration:**

| Registry | Type | Auth Type | Required Env Vars |
|----------|------|-----------|-------------------|
| GHCR | `ghcr` | `token` | `GHCR_TOKEN` (PAT with `read:packages`) |
| Docker Hub | `dockerhub` | `basic` | `DOCKER_USERNAME`, `DOCKER_PASSWORD` |
| AWS ECR | `ecr` | `aws_iam` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` |
| Custom | `custom` | `token` or `basic` | Varies |

### Services Configuration

```yaml
services:
  - name: string                  # Service identifier
    required: boolean             # Include in health checks (default: false)
    is_init_container: boolean    # Exclude from running counts (default: false)
    image_suffix: string          # Appended to registry URL for image name
    health_check:                 # Optional
      type: "http" | "tcp"        # Default: "http"
      path: string                # HTTP health check path
      port: number                # Service port
      interval: string            # Check interval (default: "30s")
    backup:                       # Optional
      enabled: boolean            # Enable backup for this service
      paths:
        - container: string       # Path inside container
          local: string           # Local backup directory name
```

**Service types:**
- **Required services**: Must be running for tenant to be "healthy"
- **Init containers**: One-time jobs (e.g., migrations), excluded from health counts
- **Optional services**: Can be stopped without affecting health status

### Backup Configuration

```yaml
backup:
  enabled: boolean                # Enable backup functionality (default: true)
  schedule: string                # Cron expression for automatic backups (e.g., "0 2 * * *" for daily at 2 AM)
  provider: "s3" | "local" | "azure" | "gcs"  # Storage provider (default: "s3")
  s3:
    endpoint_env: string          # Env var for S3 endpoint
    endpoint_template: string     # Or template: "s3:https://${ACCOUNT}.r2.cloudflarestorage.com/${BUCKET}"
    bucket_env: string            # Env var for bucket name
    access_key_env: string        # Env var for access key
    secret_key_env: string        # Env var for secret key
  restic_password_env: string     # Env var for Restic encryption password (default: "RESTIC_PASSWORD")
```

When `schedule` is set, Overwatch automatically backs up all tenants on the configured cron schedule. The schedule is displayed in the System Status section of the admin panel.

**What gets backed up:**
- Database dump (SQL file)
- Tenant `.env` configuration
- Paths defined in service backup configuration (e.g., uploads)

### Credentials Configuration

```yaml
credentials:
  db_password_length: number      # Auto-generated DB password length (default: 32)
  jwt_secret_length: number       # Auto-generated JWT secret length (default: 64)
```

### Networking Configuration

```yaml
networking:
  external_network: string        # Shared Docker network name
  tenants_path: string            # Directory where tenant configs are stored
  internal_network_template: string  # Template for tenant networks (default: "${prefix}-${tenantId}-internal")
```

### Admin Access Configuration (Optional)

Generate JWT tokens for accessing tenant applications directly:

```yaml
admin_access:
  enabled: boolean                # Enable "Access" button in UI (default: false)
  url_template: string            # URL template for access links
                                  # Default: "https://${domain}/admin-login?token=${token}"
                                  # Variables: ${domain}, ${token}, ${tenantId}
  secret_env: string              # Env var name for JWT signing secret (default: "AUTH_SERVICE_SECRET")
  token_payload:
    admin_flag: string            # JWT claim for admin status (default: "isSystemAdmin")
    email_template: string        # Admin email in token (default: "admin@overwatch.local")
    name: string                  # Admin name in token (default: "System Admin")
```

**Use case:** Your tenant application has an `/admin-login` endpoint that accepts a JWT and creates a session. Overwatch can generate these tokens so you can access any tenant without credentials.

---

## Tenant Template

The tenant template defines how tenant containers are created. Place your template in `tenant-template/docker-compose.yml`.

### Available Variables

Templates use `${VAR}` syntax for variable substitution:

| Variable | Description | Example |
|----------|-------------|---------|
| `${TENANT_ID}` | Tenant identifier | `acme` |
| `${TENANT_DOMAIN}` | Tenant's domain | `acme.example.com` |
| `${PROJECT_PREFIX}` | Container prefix from config | `myapp` |
| `${IMAGE_TAG}` | Image version to deploy | `v1.2.0` |
| `${DB_HOST}` | Database host | `myapp-mariadb` |
| `${DB_PORT}` | Database port | `3306` |
| `${DB_NAME}` | Tenant database name | `myapp_acme` |
| `${DB_USER}` | Tenant database user | `myapp_acme` |
| `${DB_PASSWORD}` | Generated DB password | (auto-generated) |
| `${JWT_SECRET}` | Generated JWT secret | (auto-generated) |
| `${SHARED_NETWORK}` | Shared Docker network | `myapp-network` |
| `${IMAGE_REGISTRY}` | Full registry path | `ghcr.io/org/repo` |

### Example Template

```yaml
# tenant-template/docker-compose.yml

services:
  backend:
    image: ${IMAGE_REGISTRY}/backend:${IMAGE_TAG}
    container_name: ${PROJECT_PREFIX}-${TENANT_ID}-backend
    restart: unless-stopped
    environment:
      NODE_ENV: production
      DB_HOST: ${DB_HOST}
      DB_PORT: ${DB_PORT}
      DB_NAME: ${DB_NAME}
      DB_USER: ${DB_USER}
      DB_PASSWORD: ${DB_PASSWORD}
      JWT_SECRET: ${JWT_SECRET}
      FRONTEND_URL: https://${TENANT_DOMAIN}
    volumes:
      - uploads:/app/uploads
    networks:
      - ${SHARED_NETWORK}
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.${TENANT_ID}-api.rule=Host(`${TENANT_DOMAIN}`) && PathPrefix(`/api`)"
      - "traefik.http.routers.${TENANT_ID}-api.entrypoints=websecure"
      - "traefik.http.routers.${TENANT_ID}-api.tls=true"
      - "traefik.http.routers.${TENANT_ID}-api.tls.certresolver=letsencrypt"
      - "traefik.http.services.${TENANT_ID}-api.loadbalancer.server.port=3001"
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:3001/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
    depends_on:
      - migrator

  frontend:
    image: ${IMAGE_REGISTRY}/frontend:${IMAGE_TAG}
    container_name: ${PROJECT_PREFIX}-${TENANT_ID}-frontend
    restart: unless-stopped
    networks:
      - ${SHARED_NETWORK}
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.${TENANT_ID}-frontend.rule=Host(`${TENANT_DOMAIN}`)"
      - "traefik.http.routers.${TENANT_ID}-frontend.entrypoints=websecure"
      - "traefik.http.routers.${TENANT_ID}-frontend.tls=true"
      - "traefik.http.routers.${TENANT_ID}-frontend.tls.certresolver=letsencrypt"
      - "traefik.http.routers.${TENANT_ID}-frontend.priority=1"
      - "traefik.http.services.${TENANT_ID}-frontend.loadbalancer.server.port=80"

  migrator:
    image: ${IMAGE_REGISTRY}/backend:${IMAGE_TAG}
    container_name: ${PROJECT_PREFIX}-${TENANT_ID}-migrator
    environment:
      DB_HOST: ${DB_HOST}
      DB_PORT: ${DB_PORT}
      DB_NAME: ${DB_NAME}
      DB_USER: ${DB_USER}
      DB_PASSWORD: ${DB_PASSWORD}
    command: ["npm", "run", "db:migrate"]
    networks:
      - ${SHARED_NETWORK}
    restart: "no"

networks:
  ${SHARED_NETWORK}:
    external: true

volumes:
  uploads:
    name: ${PROJECT_PREFIX}-${TENANT_ID}-uploads
```

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

### Registry (name from config)

| Variable | Description |
|----------|-------------|
| `GHCR_TOKEN` | GitHub Personal Access Token (GHCR) |
| `DOCKER_USERNAME` | Docker Hub username |
| `DOCKER_PASSWORD` | Docker Hub password/token |
| `AWS_ACCESS_KEY_ID` | AWS access key (ECR) |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key (ECR) |
| `AWS_REGION` | AWS region (ECR) |

### Backup (optional)

| Variable | Description |
|----------|-------------|
| `R2_ENDPOINT` | S3 endpoint URL |
| `R2_BUCKET_NAME` | S3 bucket name |
| `R2_ACCESS_KEY_ID` | S3 access key |
| `R2_SECRET_ACCESS_KEY` | S3 secret key |
| `RESTIC_PASSWORD` | Restic encryption password |

### Admin Access (optional)

| Variable | Description |
|----------|-------------|
| `AUTH_SERVICE_SECRET` | JWT secret for tenant access tokens |

### Other

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3002` | Overwatch HTTP port |
| `ALLOWED_ADMIN_EMAILS` | (none) | Comma-separated initial admin emails |

> **Note:** Paths for tenants, templates, and data are configured in `overwatch.yaml` (under `networking.tenants_path`, `tenant_template.dir`, and `data_dir`). There are no environment variable overrides for these.
