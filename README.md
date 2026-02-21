# Overwatch

A universal, configuration-driven multi-tenant management tool for containerized applications.

Overwatch provides a web-based admin panel to manage multi-tenant deployments, including tenant lifecycle management, container operations, backups, and version updates. It's designed to be project-agnostic - configure it once for your application, and it handles all the complexity.

## Features

- **Tenant Management**: Create, update, delete, start, stop, and restart tenants
- **Container Operations**: View logs, restart containers, health monitoring
- **Version Management**: List available image tags, deploy specific versions per tenant
- **Backup & Restore**: Full tenant backups using Restic (database + files), restore to existing or new tenants
- **Automated Backup Scheduling**: Built-in cron scheduler for automatic backups (via `node-cron`)
- **Environment Variable Management**: Global and per-tenant environment variables with override support
- **Admin User Management**: Add/remove admin users at runtime through the UI
- **Audit Logging**: Track all state-changing operations with user, action, and timestamp
- **Admin Access**: Generate JWT tokens for direct tenant application access (optional)
- **Google OAuth**: Secure admin panel login with allowlist
- **Self-Update**: Update Overwatch via SSH script (`scripts/update.sh`)

## Supported Infrastructure

**Databases:**
- MySQL / MariaDB
- PostgreSQL

**Container Registries:**
- GitHub Container Registry (GHCR)
- Docker Hub
- Amazon ECR
- Custom registries

**Backup Providers:**
- S3-compatible storage (AWS S3, Cloudflare R2, MinIO, etc.)

---

## Table of Contents

- [Quick Start](#quick-start)
- [Configuration Reference](#configuration-reference)
- [Tenant Template](#tenant-template)
- [Environment Variables](#environment-variables)
- [API Reference](#api-reference)
- [Deployment](#deployment)
- [Updating](#updating)
- [CI/CD & Automation](#cicd--automation)
- [Interactive Setup (overwatch init)](#interactive-setup-overwatch-init)
- [Deploying for a New Project](#deploying-for-a-new-project)
- [Architecture](#architecture)
- [Security](#security)
- [Development](#development)
- [Troubleshooting](#troubleshooting)

---

## Quick Start

### 1. Clone and Configure

```bash
git clone https://github.com/marwain91/overwatch.git
cd overwatch
cp overwatch.yaml overwatch.yaml.backup
```

### 2. Edit Configuration

Edit `overwatch.yaml` to match your project:

```yaml
project:
  name: "MyApp"
  prefix: "myapp"           # Container prefix: myapp-{tenantId}-{service}
  db_prefix: "myapp"        # Database prefix: myapp_{tenantId}

database:
  type: "mariadb"           # "mysql" | "mariadb" | "postgres"
  host: "myapp-mariadb"     # Database host/container name
  port: 3306
  root_user: "root"
  root_password_env: "MYSQL_ROOT_PASSWORD"
  container_name: "myapp-mariadb"

registry:
  type: "ghcr"              # "ghcr" | "dockerhub" | "ecr" | "custom"
  url: "ghcr.io"
  repository: "your-org/your-app"
  auth:
    type: "token"
    token_env: "GHCR_TOKEN"

services:
  - name: "backend"
    required: true
    image_suffix: "backend"
    backup:
      enabled: true
      paths:
        - container: "/app/uploads"
          local: "uploads"

  - name: "frontend"
    required: true
    image_suffix: "frontend"

  - name: "migrator"
    is_init_container: true
    image_suffix: "backend"
```

### 3. Generate Environment File

Run the setup script to generate a `.env` tailored to your `overwatch.yaml`:

```bash
npm run setup
```

This reads your config and generates a `.env` with only the variables your setup needs. Fill in the values marked `<FILL_IN>`, then validate:

```bash
npm run setup:check
```

### 4. Create Tenant Template

Create `tenant-template/docker-compose.yml` - this template is used when creating new tenants. See [Tenant Template](#tenant-template) section for details.

### 5. Run Overwatch

```bash
# Build and start
docker compose up -d

# View logs
docker compose logs -f
```

Access the admin panel at `http://localhost:3002`.

---

## Configuration Reference

### `overwatch.yaml` Schema

#### Project Configuration

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

#### Database Configuration

```yaml
database:
  type: "mysql" | "mariadb" | "postgres"
  host: string                    # Database server hostname
  port: number                    # Default: 3306 (MySQL) or 5432 (Postgres)
  root_user: string               # Default: "root"
  root_password_env: string       # Environment variable name for root password
  container_name: string          # Docker container name (for dumps via docker exec)
```

#### Registry Configuration

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

#### Services Configuration

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

#### Backup Configuration

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

#### Credentials Configuration

```yaml
credentials:
  db_password_length: number      # Auto-generated DB password length (default: 32)
  jwt_secret_length: number       # Auto-generated JWT secret length (default: 64)
```

#### Networking Configuration

```yaml
networking:
  external_network: string        # Shared Docker network name
  tenants_path: string            # Directory where tenant configs are stored
  internal_network_template: string  # Template for tenant networks (default: "${prefix}-${tenantId}-internal")
```

#### Admin Access Configuration (Optional)

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

---

## API Reference

All API endpoints require authentication via Bearer token (except `/api/auth/*` and `/health`).

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/auth/google` | Login with Google OAuth credential |
| `GET` | `/api/auth/verify` | Verify current JWT token |
| `GET` | `/api/auth/config` | Get Google Client ID for frontend |

### Tenants

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

### Status & Containers

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/status/health` | System health overview |
| `GET` | `/api/status/containers` | List managed containers |
| `GET` | `/api/status/containers/:id/logs` | Get container logs |
| `POST` | `/api/status/containers/:id/restart` | Restart specific container |
| `GET` | `/api/status/tags` | List available image tags |
| `GET` | `/api/status/config` | Get project configuration |

### Backups

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

### Environment Variables

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/env-vars` | List global environment variables |
| `POST` | `/api/env-vars` | Create or update a global variable |
| `DELETE` | `/api/env-vars/:key` | Delete a global variable |
| `GET` | `/api/env-vars/tenants/:tenantId` | Get effective variables for a tenant |
| `POST` | `/api/env-vars/tenants/:tenantId/overrides` | Set a tenant-specific override |
| `DELETE` | `/api/env-vars/tenants/:tenantId/overrides/:key` | Remove a tenant override |

### Admin Users

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/admin-users` | List admin users |
| `POST` | `/api/admin-users` | Add admin user |
| `DELETE` | `/api/admin-users/:email` | Remove admin user |

### Audit Logs

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/audit-logs` | List recent audit log entries (default 50, max 200) |

### Health Check

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Simple health check (no auth) |

---

## Deployment

### Docker Compose (Recommended)

```yaml
services:
  overwatch:
    image: ghcr.io/marwain91/overwatch:latest
    container_name: overwatch
    restart: unless-stopped
    env_file: .env
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /root/.docker:/root/.docker:ro          # Registry credentials (for pulling tenant images)
      - ./overwatch.yaml:/app/overwatch.yaml:ro
      - ./data/admin-users.json:/app/data/admin-users.json
      - ./data/env-vars.json:/app/data/env-vars.json
      - ./data/tenant-env-overrides.json:/app/data/tenant-env-overrides.json
      - ./data/audit.log:/app/data/audit.log
      - ./tenants:/app/tenants
      - ./tenant-template:/app/tenant-template:ro
    networks:
      - myapp-network
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.overwatch.rule=Host(`overwatch.example.com`)"
      - "traefik.http.routers.overwatch.entrypoints=websecure"
      - "traefik.http.routers.overwatch.tls=true"
      - "traefik.http.routers.overwatch.tls.certresolver=letsencrypt"
      - "traefik.http.services.overwatch.loadbalancer.server.port=3002"
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:3002/health"]
      interval: 30s
      timeout: 10s
      retries: 3
    deploy:
      resources:
        limits:
          memory: 512M

networks:
  myapp-network:
    external: true
```

> **Note:** The `/root/.docker` mount shares Docker registry credentials so Overwatch can pull tenant images. If your registry doesn't require authentication, you can omit it. When using Traefik, you don't need `ports:` — Traefik routes traffic via the shared Docker network.

### Network Requirements

Overwatch needs access to:

1. **Docker socket** (`/var/run/docker.sock`) — for container management
2. **Database container** — on the same Docker network
3. **Tenant configs directory** — mounted volume
4. **Reverse proxy** (Traefik, nginx, etc.) — shares the Docker network for routing

### Production Checklist

- [ ] Configure strong `JWT_SECRET` (min 32 characters)
- [ ] Set up Google OAuth and configure `GOOGLE_CLIENT_ID`
- [ ] Add initial admin emails via `ALLOWED_ADMIN_EMAILS`
- [ ] Configure database credentials
- [ ] Configure registry credentials
- [ ] Create and customize tenant template
- [ ] Set up backup credentials and initialize repository (`POST /api/backups/init`)
- [ ] Configure backup schedule in `overwatch.yaml` (e.g., `schedule: "0 2 * * *"`)
- [ ] Connect to shared Docker network
- [ ] Mount tenant configs directory
- [ ] Mount Docker credentials (`/root/.docker`) if using private registry
- [ ] Configure reverse proxy (Traefik/nginx) for HTTPS
- [ ] Set appropriate file permissions on mounted volumes
- [ ] Set resource limits (`deploy.resources.limits`)
- [ ] Verify healthcheck endpoint responds (`/health`)

---

## Updating

Overwatch is updated via the `scripts/update.sh` SSH script. Connect to your server and run:

```bash
./scripts/update.sh
```

This will pull the latest image, compare digests, and recreate the container if an update is available.

To check for updates without applying:

```bash
./scripts/update.sh --check
```

### Environment Overrides

| Variable | Default | Description |
|----------|---------|-------------|
| `COMPOSE_DIR` | Parent of `scripts/` directory | Path to the directory containing `docker-compose.yml` |
| `SERVICE_NAME` | `overwatch` | Docker Compose service name to restart |
| `IMAGE` | `ghcr.io/marwain91/overwatch:latest` | Image to pull and check |

Example with overrides:

```bash
COMPOSE_DIR=/opt/myapp/deploy SERVICE_NAME=admin ./scripts/update.sh
```

---

## CI/CD & Automation

Automate server provisioning and Overwatch updates with CI/CD workflows. The examples below use GitHub Actions but the pattern works with any CI system.

### Server Setup Workflow

A `workflow_dispatch` workflow that provisions a fresh server with Docker, copies deploy files, and starts everything:

```yaml
# .github/workflows/setup-server.yml
name: Setup Server

on:
  workflow_dispatch:
    inputs:
      server_ip:
        description: "Server IP address"
        required: true

jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Docker on server
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ inputs.server_ip }}
          username: root
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          script: |
            curl -fsSL https://get.docker.com | sh

      - name: Copy deploy files
        uses: appleboy/scp-action@v0.1.7
        with:
          host: ${{ inputs.server_ip }}
          username: root
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          source: "deploy/*"
          target: "/opt/myapp"
          strip_components: 0

      - name: Generate .env and start services
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ inputs.server_ip }}
          username: root
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          script: |
            cd /opt/myapp/deploy

            # Generate .env from secrets
            cat > overwatch/.env << 'ENVEOF'
            JWT_SECRET=${{ secrets.JWT_SECRET }}
            GOOGLE_CLIENT_ID=${{ secrets.GOOGLE_CLIENT_ID }}
            MYSQL_ROOT_PASSWORD=${{ secrets.MYSQL_ROOT_PASSWORD }}
            GHCR_TOKEN=${{ secrets.GHCR_TOKEN }}
            ALLOWED_ADMIN_EMAILS=${{ secrets.ADMIN_EMAILS }}
            ENVEOF

            # Create shared network
            docker network create myapp-network || true

            # Start infrastructure first, then Overwatch
            docker compose -f infrastructure/docker-compose.yml up -d
            sleep 10
            docker compose -f overwatch/docker-compose.yml up -d
```

### Auto-Update Workflow

A scheduled workflow that checks for new Overwatch images and recreates the container if an update is available:

```yaml
# .github/workflows/update-overwatch.yml
name: Update Overwatch

on:
  schedule:
    - cron: "0 4 * * 1"    # Weekly on Monday at 4 AM
  workflow_dispatch:         # Manual trigger

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Update Overwatch
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.SERVER_IP }}
          username: root
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          script: |
            cd /opt/myapp/deploy/overwatch

            IMAGE="ghcr.io/marwain91/overwatch:latest"

            # Get current digest
            CURRENT=$(docker inspect --format='{{index .RepoDigests 0}}' "$IMAGE" 2>/dev/null || echo "none")

            # Pull latest
            docker pull "$IMAGE"

            # Get new digest
            NEW=$(docker inspect --format='{{index .RepoDigests 0}}' "$IMAGE" 2>/dev/null || echo "unknown")

            # Recreate if changed
            if [ "$CURRENT" != "$NEW" ]; then
              echo "Update available, recreating container..."
              docker compose up -d --force-recreate overwatch
              echo "Updated: $NEW"
            else
              echo "Already up to date: $CURRENT"
            fi
```

> **Tip:** You can also use the bundled `scripts/update.sh` script directly on the server instead of a CI workflow. See [Updating](#updating).

---

## Interactive Setup (overwatch init)

Deploy Overwatch on a production server in under 5 minutes. Only Docker is required.

### 1. Install the CLI

```bash
# x64
curl -fsSL https://github.com/marwain91/overwatch/releases/latest/download/overwatch-linux-x64 -o /usr/local/bin/overwatch && chmod +x /usr/local/bin/overwatch

# ARM64
curl -fsSL https://github.com/marwain91/overwatch/releases/latest/download/overwatch-linux-arm64 -o /usr/local/bin/overwatch && chmod +x /usr/local/bin/overwatch
```

### 2. Run the setup

```bash
overwatch init
```

The wizard walks you through project name, domain, database (MariaDB/PostgreSQL), container registry credentials, DNS provider for SSL, Google OAuth, and optional S3 backups. Everything has sensible defaults — press Enter to accept them.

After confirming, it generates a complete deployment:

```
/opt/myapp/deploy/
├── infrastructure/           # Traefik reverse proxy + database
│   ├── docker-compose.yml
│   └── .env
├── overwatch/                # Overwatch instance
│   ├── docker-compose.yml
│   ├── overwatch.yaml
│   ├── .env
│   └── data/
├── tenants/                  # Auto-managed by Overwatch
└── tenant-template/          # Your app's compose template (add after init)
```

### 3. Start

```bash
overwatch start
```

That's it. Open `https://overwatch.yourdomain.com` and log in.

> Add your tenant template (`docker-compose.yml`) to `tenant-template/` before creating tenants. See [Tenant Template](#tenant-template) for the format.

### All CLI commands

| Command | Description |
|---------|-------------|
| `overwatch init` | Interactive setup — generates all config files |
| `overwatch start` | Start infrastructure + Overwatch |
| `overwatch stop` | Stop Overwatch + infrastructure |
| `overwatch restart` | Restart all services |
| `overwatch status` | Show service status |
| `overwatch update` | Pull latest image and restart |
| `overwatch update --check` | Check for updates without applying |

For a manual step-by-step setup without the CLI, see [Deploying for a New Project](#deploying-for-a-new-project) below.

---

## Deploying for a New Project

This guide walks through deploying Overwatch on a production server to manage a multi-tenant containerized application. It uses a **separated directory pattern** where infrastructure, Overwatch, and tenants each have their own compose files.

### Prerequisites

- A server (VPS, cloud instance, etc.) with Docker and Docker Compose installed
- Your application images published to a container registry (GHCR, Docker Hub, ECR, etc.)
- A domain with DNS configured (e.g., `*.example.com` pointing to your server)
- DNS provider API credentials for wildcard SSL (e.g., Cloudflare API token)

### Directory Structure

The deployment uses a separated layout — infrastructure, Overwatch, and tenants are independent compose stacks sharing a Docker network:

```
/opt/myapp/deploy/
├── infrastructure/        # Traefik reverse proxy + database
│   └── docker-compose.yml
├── overwatch/             # Overwatch instance
│   ├── docker-compose.yml
│   ├── overwatch.yaml
│   └── .env
├── tenants/               # Auto-generated by Overwatch
│   ├── tenant-a/
│   └── tenant-b/
└── tenant-template/       # Template for new tenants
    └── docker-compose.yml
```

This separation means you can restart infrastructure without touching Overwatch, update Overwatch without affecting tenants, and each component has its own lifecycle.

### Step 1: Create directory structure

```bash
mkdir -p /opt/myapp/deploy/{infrastructure,overwatch,overwatch/data,tenant-template,tenants}
```

### Step 2: Set up infrastructure

Create the Traefik reverse proxy and database. This example uses MariaDB — substitute PostgreSQL if preferred.

**`infrastructure/docker-compose.yml`:**

```yaml
services:
  traefik:
    image: traefik:v3.3
    container_name: myapp-traefik
    restart: unless-stopped
    command:
      - "--api.dashboard=false"
      - "--providers.docker=true"
      - "--providers.docker.exposedbydefault=false"
      - "--providers.docker.network=myapp-network"
      - "--entrypoints.web.address=:80"
      - "--entrypoints.web.http.redirections.entrypoint.to=websecure"
      - "--entrypoints.websecure.address=:443"
      # Wildcard SSL via DNS challenge (Cloudflare example)
      - "--certificatesresolvers.letsencrypt.acme.dnschallenge=true"
      - "--certificatesresolvers.letsencrypt.acme.dnschallenge.provider=cloudflare"
      - "--certificatesresolvers.letsencrypt.acme.email=admin@example.com"
      - "--certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json"
      # HTTP challenge for custom tenant domains
      - "--certificatesresolvers.letsencrypt-http.acme.httpchallenge=true"
      - "--certificatesresolvers.letsencrypt-http.acme.httpchallenge.entrypoint=web"
      - "--certificatesresolvers.letsencrypt-http.acme.email=admin@example.com"
      - "--certificatesresolvers.letsencrypt-http.acme.storage=/letsencrypt/acme.json"
    environment:
      CF_DNS_API_TOKEN: "${CF_DNS_API_TOKEN}"
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - letsencrypt:/letsencrypt
    networks:
      - myapp-network

  mariadb:
    image: mariadb:11
    container_name: myapp-mariadb
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: "${MYSQL_ROOT_PASSWORD}"
    volumes:
      - mariadb-data:/var/lib/mysql
    networks:
      - myapp-network
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 30s
      timeout: 10s
      retries: 3

networks:
  myapp-network:
    name: myapp-network

volumes:
  letsencrypt:
  mariadb-data:
```

> **Note:** This example uses Cloudflare for DNS challenge (set `CF_DNS_API_TOKEN` in the infrastructure `.env`). Traefik supports [many DNS providers](https://doc.traefik.io/traefik/https/acme/#providers). The HTTP challenge resolver is available for tenants using custom (non-wildcard) domains.

### Step 3: Configure Overwatch

Create the Overwatch configuration file.

**`overwatch/overwatch.yaml`:**

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

registry:
  type: "ghcr"
  url: "ghcr.io"
  repository: "myorg/myapp"
  auth:
    type: "token"
    token_env: "GHCR_TOKEN"

services:
  - name: "backend"
    required: true
    image_suffix: "backend"
    backup:
      enabled: true
      paths:
        - container: "/app/uploads"
          local: "uploads"

  - name: "frontend"
    required: true
    image_suffix: "frontend"

  - name: "migrator"
    is_init_container: true
    image_suffix: "backend"

backup:
  enabled: true
  schedule: "0 2 * * *"     # Daily at 2 AM
  provider: "s3"
  s3:
    endpoint_template: "s3:https://${ACCOUNT}.r2.cloudflarestorage.com/${BUCKET}"
    bucket_env: "R2_BUCKET_NAME"
    access_key_env: "R2_ACCESS_KEY_ID"
    secret_key_env: "R2_SECRET_ACCESS_KEY"
  restic_password_env: "RESTIC_PASSWORD"

admin_access:
  enabled: true
  url_template: "https://${domain}/admin-login?token=${token}"

networking:
  external_network: "myapp-network"
  tenants_path: "/app/tenants"
```

Then generate the `.env` file:

```bash
# From the overwatch directory (or use npm run setup from the repo)
# Fill in all values marked <FILL_IN>
```

### Step 4: Deploy Overwatch

**`overwatch/docker-compose.yml`:**

```yaml
services:
  overwatch:
    image: ghcr.io/marwain91/overwatch:latest
    container_name: myapp-overwatch
    restart: unless-stopped
    env_file: .env
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /root/.docker:/root/.docker:ro
      - ./overwatch.yaml:/app/overwatch.yaml:ro
      - ./data/admin-users.json:/app/data/admin-users.json
      - ./data/env-vars.json:/app/data/env-vars.json
      - ./data/tenant-env-overrides.json:/app/data/tenant-env-overrides.json
      - ./data/audit.log:/app/data/audit.log
      - ../tenants:/app/tenants
      - ../tenant-template:/app/tenant-template:ro
    networks:
      - myapp-network
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.overwatch.rule=Host(`overwatch.example.com`)"
      - "traefik.http.routers.overwatch.entrypoints=websecure"
      - "traefik.http.routers.overwatch.tls=true"
      - "traefik.http.routers.overwatch.tls.certresolver=letsencrypt"
      - "traefik.http.services.overwatch.loadbalancer.server.port=3002"
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:3002/health"]
      interval: 30s
      timeout: 10s
      retries: 3
    deploy:
      resources:
        limits:
          memory: 512M

networks:
  myapp-network:
    external: true
```

### Step 5: Create tenant template

The tenant template defines what containers each tenant gets. Overwatch uses this to generate per-tenant compose files. See [Tenant Template](#tenant-template) for all available variables.

**`tenant-template/docker-compose.yml`:**

```yaml
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
    env_file:
      - shared.env
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
      migrator:
        condition: service_completed_successfully

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

### Step 6: Start everything

Boot order matters — infrastructure must be running before Overwatch starts:

```bash
cd /opt/myapp/deploy

# 1. Create shared network (if not created by infrastructure compose)
docker network create myapp-network || true

# 2. Start infrastructure (Traefik + database)
docker compose -f infrastructure/docker-compose.yml up -d

# 3. Wait for database to be healthy
sleep 10

# 4. Start Overwatch
docker compose -f overwatch/docker-compose.yml up -d
```

Access Overwatch at `https://overwatch.example.com`, log in with Google OAuth, and create your first tenant.

### Final Directory Structure

After setting everything up and creating a few tenants:

```
/opt/myapp/deploy/
├── infrastructure/
│   ├── docker-compose.yml        # Traefik + MariaDB
│   └── .env                      # CF_DNS_API_TOKEN, MYSQL_ROOT_PASSWORD
├── overwatch/
│   ├── docker-compose.yml        # Overwatch container
│   ├── overwatch.yaml            # Project configuration
│   ├── .env                      # Overwatch secrets
│   └── data/
│       ├── admin-users.json      # Admin user list
│       ├── env-vars.json         # Global environment variables
│       ├── tenant-env-overrides.json
│       └── audit.log             # Audit log (JSON lines)
├── tenants/                      # Auto-generated by Overwatch
│   ├── tenant-a/
│   │   ├── docker-compose.yml    # Generated from template
│   │   ├── .env                  # Tenant-specific config
│   │   └── shared.env            # Global + override env vars
│   └── tenant-b/
│       ├── docker-compose.yml
│       ├── .env
│       └── shared.env
└── tenant-template/
    └── docker-compose.yml        # Template for new tenants
```

---

## Architecture

```
Overwatch Instance
├── Web UI (admin panel)
├── API Server (Express.js)
│   ├── Authentication (Google OAuth + JWT)
│   ├── Tenant Management
│   ├── Container Operations (via Docker API)
│   ├── Backup/Restore (via Restic)
│   ├── Backup Scheduler (node-cron)
│   ├── Environment Variable Management
│   ├── Admin User Management
│   ├── Audit Logging
│   ├── Rate Limiting
│   └── Registry Integration
├── Database Adapter
│   ├── MySQL/MariaDB adapter
│   └── PostgreSQL adapter
└── Registry Adapter
    ├── GHCR adapter
    ├── Docker Hub adapter
    ├── ECR adapter
    └── Custom adapter

Managed Infrastructure
├── Shared Database Engine
│   ├── myapp_tenant1
│   ├── myapp_tenant2
│   └── ...
├── Shared Docker Network
│   ├── myapp-tenant1-backend
│   ├── myapp-tenant1-frontend
│   ├── myapp-tenant2-backend
│   └── ...
├── Reverse Proxy (Traefik) - external
└── Backup Storage (S3) - external
```

### Project Structure

```
overwatch/
├── src/
│   ├── index.ts              # Express app entry point
│   ├── config/
│   │   ├── schema.ts         # Zod validation schemas
│   │   ├── loader.ts         # Config file loader
│   │   ├── validate.ts       # Startup environment validation
│   │   └── index.ts          # Config exports
│   ├── adapters/
│   │   ├── database/         # MySQL/MariaDB, PostgreSQL adapters
│   │   │   ├── types.ts      # DatabaseAdapter interface
│   │   │   ├── mysql.ts      # MySQL/MariaDB implementation
│   │   │   ├── postgres.ts   # PostgreSQL implementation
│   │   │   └── index.ts      # Factory function
│   │   └── registry/         # GHCR, Docker Hub, ECR adapters
│   │       ├── types.ts      # RegistryAdapter interface
│   │       ├── ghcr.ts       # GitHub Container Registry
│   │       ├── dockerhub.ts  # Docker Hub
│   │       ├── ecr.ts        # Amazon ECR
│   │       ├── custom.ts     # Custom registries
│   │       └── index.ts      # Factory function
│   ├── services/
│   │   ├── docker.ts         # Container management
│   │   ├── tenant.ts         # Tenant CRUD operations
│   │   ├── backup.ts         # Backup/restore with Restic
│   │   ├── scheduler.ts      # Backup cron scheduler
│   │   ├── users.ts          # Admin user management
│   │   ├── envVars.ts        # Environment variable management
│   │   └── fileLock.ts       # File locking for concurrent access
│   ├── routes/
│   │   ├── auth.ts           # Authentication endpoints
│   │   ├── tenants.ts        # Tenant endpoints
│   │   ├── status.ts         # System status endpoints
│   │   ├── backups.ts        # Backup endpoints
│   │   ├── adminUsers.ts     # Admin user endpoints
│   │   ├── envVars.ts        # Environment variable endpoints
│   │   └── auditLogs.ts      # Audit log endpoints
│   ├── middleware/
│   │   ├── auth.ts           # JWT authentication
│   │   ├── audit.ts          # Audit logging
│   │   └── rateLimit.ts      # API rate limiting
│   └── utils/
│       └── asyncHandler.ts   # Async route error handling
├── public/                   # Static frontend files
├── tenant-template/          # Tenant docker-compose template
├── overwatch.yaml            # Main configuration
├── docker-compose.yml        # Overwatch deployment
├── Dockerfile                # Container image
├── scripts/
│   ├── setup.ts              # Setup wizard (npm run setup)
│   └── update.sh             # Self-update script
└── package.json
```

---

## Security

### Access Control

- **Google OAuth**: Only users with Google accounts can attempt login
- **Email Allowlist**: Only emails in the admin users list can access
- **JWT Sessions**: 7-day expiring tokens for session management
- **Self-removal protection**: Cannot remove yourself or the last admin

### Secrets Management

- Database passwords for tenants are auto-generated (configurable length)
- JWT secrets for tenants are auto-generated (configurable length)
- All secrets stored in tenant `.env` files (not in database)
- Root credentials only in Overwatch's environment

### Docker Socket Security

Mounting the Docker socket gives Overwatch full control over containers. Consider:

- Running Overwatch in an isolated network
- Using Docker socket proxy with limited permissions
- Restricting network access to the Overwatch container
- Regular security audits

---

## Development

### Local Development

```bash
# Install dependencies
npm install

# Generate .env from overwatch.yaml (interactive setup)
npm run setup

# Validate .env against config
npm run setup:check

# Start development server (with hot reload)
npm run dev

# Build for production
npm run build

# Run production build
npm start
```

### Building Docker Image

```bash
# Build image
docker build -t overwatch .

# Run locally
docker run -p 3002:3002 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $(pwd)/overwatch.yaml:/app/overwatch.yaml:ro \
  -e JWT_SECRET=dev-secret \
  -e GOOGLE_CLIENT_ID=your-client-id \
  overwatch
```

---

## Troubleshooting

### Tenants Not Showing

**Symptom:** Dashboard shows 0 tenants but tenant directories exist.

**Solution:** Check that `networking.tenants_path` in config matches the mounted volume path. The path inside the container must match where tenant directories actually exist.

### Database Connection Failed

**Symptom:** "Failed to connect to database" error.

**Solutions:**
1. Verify Overwatch is on the same Docker network as the database
2. Check `database.host` matches the database container name
3. Verify root password environment variable is set correctly
4. Check database container is running and healthy

### Registry Login Failed

**Symptom:** "Failed to login to registry" on startup.

**Solutions:**
1. Verify registry credentials environment variables are set
2. For GHCR: Ensure token has `read:packages` scope
3. For ECR: Ensure AWS credentials have ECR pull permissions
4. For Docker Hub: Use access token instead of password

### Backup Repository Locked

**Symptom:** "Repository is already locked" error.

**Solution:** Use the "Unlock" button in the Backups section, or call `POST /api/backups/unlock`. This removes stale locks from interrupted operations.

### Container Health Shows Unhealthy

**Symptom:** Tenant shows as unhealthy despite containers running.

**Solutions:**
1. Check container logs for application errors
2. Verify health check paths in config match your application
3. Check database connectivity from tenant containers
4. Ensure required services are correctly marked in config

### Google OAuth Not Working

**Symptom:** "Google OAuth not configured" error.

**Solutions:**
1. Verify `GOOGLE_CLIENT_ID` environment variable is set
2. Check Google Cloud Console for correct OAuth client configuration
3. Ensure authorized JavaScript origins include your Overwatch URL
4. Verify authorized redirect URIs are configured

### Access Token Generation Failed

**Symptom:** "AUTH_SERVICE_SECRET not configured" when clicking Access.

**Solutions:**
1. Set `AUTH_SERVICE_SECRET` environment variable
2. Ensure `admin_access.enabled: true` in config
3. Verify `admin_access.secret_env` matches your environment variable name

---

## License

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

For bugs and feature requests, please [open an issue](https://github.com/marwain91/overwatch/issues).
