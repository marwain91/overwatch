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
    ports:
      - "3002:3002"
    environment:
      PORT: 3002
      JWT_SECRET: ${JWT_SECRET}
      GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID}
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD}
      GHCR_TOKEN: ${GHCR_TOKEN}
      # Backup env vars (optional)
      R2_ENDPOINT: ${R2_ENDPOINT:-}
      R2_BUCKET_NAME: ${R2_BUCKET_NAME:-}
      R2_ACCESS_KEY_ID: ${R2_ACCESS_KEY_ID:-}
      R2_SECRET_ACCESS_KEY: ${R2_SECRET_ACCESS_KEY:-}
      RESTIC_PASSWORD: ${RESTIC_PASSWORD:-}
      # Admin access (optional)
      AUTH_SERVICE_SECRET: ${AUTH_SERVICE_SECRET:-}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./overwatch.yaml:/app/overwatch.yaml:ro
      - ./data/admin-users.json:/app/data/admin-users.json
      - ./data/env-vars.json:/app/data/env-vars.json
      - ./data/tenant-env-overrides.json:/app/data/tenant-env-overrides.json
      - ./data/audit.log:/app/data/audit.log
      - /opt/myapp/tenants:/app/tenants
      - ./tenant-template:/app/tenant-template:ro
    networks:
      - myapp-network

networks:
  myapp-network:
    external: true
```

### Network Requirements

Overwatch needs access to:

1. **Docker socket** (`/var/run/docker.sock`) - for container management
2. **Database container** - on the same Docker network
3. **Tenant configs directory** - mounted volume
4. **Traefik/proxy** - optional, for routing (shares network)

### Production Checklist

- [ ] Configure strong `JWT_SECRET` (min 32 characters)
- [ ] Set up Google OAuth and configure `GOOGLE_CLIENT_ID`
- [ ] Add initial admin emails via `ALLOWED_ADMIN_EMAILS`
- [ ] Configure database credentials
- [ ] Configure registry credentials
- [ ] Create and customize tenant template
- [ ] Set up backup credentials (recommended)
- [ ] Connect to shared Docker network
- [ ] Mount tenant configs directory
- [ ] Configure reverse proxy (Traefik/nginx) for HTTPS
- [ ] Set appropriate file permissions on mounted volumes

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

## Deploying for a New Project

This guide walks through adapting Overwatch to manage a completely different containerized application.

### Prerequisites

- Docker and Docker Compose installed on the server
- A database engine (MySQL, MariaDB, or PostgreSQL) running in Docker
- Your application images published to a container registry (GHCR, Docker Hub, ECR, or a custom registry)
- A reverse proxy (Traefik, nginx, etc.) for HTTPS termination (recommended)

### Step-by-step Setup

#### 1. Create a deploy directory

```bash
mkdir -p /opt/myapp/deploy
cd /opt/myapp/deploy
```

#### 2. Write `overwatch.yaml`

Define your project, database, registry, and services:

```yaml
project:
  name: "My App"
  prefix: "myapp"
  db_prefix: "myapp"

database:
  type: "postgres"
  host: "myapp-postgres"
  port: 5432
  root_user: "postgres"
  root_password_env: "POSTGRES_PASSWORD"
  container_name: "myapp-postgres"

registry:
  type: "dockerhub"
  url: "docker.io"
  repository: "myorg/myapp"
  auth:
    type: "basic"
    username_env: "DOCKER_USERNAME"

services:
  - name: "app"
    required: true
    image_suffix: "app"

networking:
  external_network: "myapp-network"
  tenants_path: "/app/tenants"
```

#### 3. Generate `.env`

```bash
npm run setup
```

This reads your `overwatch.yaml` and generates a `.env` with only the variables your configuration requires. Fill in the values marked `<FILL_IN>`.

#### 4. Create a tenant template

Create `tenant-template/docker-compose.yml` using the variables documented in [Tenant Template](#tenant-template). This defines what containers each tenant gets.

#### 5. Set up Docker Compose

Create `docker-compose.yml` for Overwatch alongside your infrastructure:

```yaml
services:
  overwatch:
    image: ghcr.io/marwain91/overwatch:latest
    container_name: overwatch
    restart: unless-stopped
    ports:
      - "3002:3002"
    env_file: .env
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./overwatch.yaml:/app/overwatch.yaml:ro
      - ./data/admin-users.json:/app/data/admin-users.json
      - ./data/env-vars.json:/app/data/env-vars.json
      - ./data/tenant-env-overrides.json:/app/data/tenant-env-overrides.json
      - ./data/audit.log:/app/data/audit.log
      - ./tenants:/app/tenants
      - ./tenant-template:/app/tenant-template:ro
    networks:
      - myapp-network

  postgres:
    image: postgres:16
    container_name: myapp-postgres
    restart: unless-stopped
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    networks:
      - myapp-network

networks:
  myapp-network:
    name: myapp-network

volumes:
  pgdata:
```

#### 6. Start everything

```bash
docker compose up -d
```

Access Overwatch at `http://<your-server>:3002`, log in with Google OAuth, and create your first tenant.

### Example

Suppose you're deploying **Acme SaaS** — a Node.js app with a PostgreSQL database, images on Docker Hub at `acmecorp/acme-saas`.

| Setting | Value |
|---------|-------|
| `project.prefix` | `acme` |
| `database.type` | `postgres` |
| `registry.type` | `dockerhub` |
| `registry.repository` | `acmecorp/acme-saas` |
| `services[0].name` | `app` |
| `services[0].image_suffix` | `app` |
| `networking.external_network` | `acme-network` |

Tenants will get containers named `acme-{tenantId}-app`, databases named `acme_{tenantId}`, and connect to the shared `acme-network`.

### Final Directory Structure

```
/opt/myapp/deploy/
├── docker-compose.yml          # Overwatch + infrastructure
├── overwatch.yaml              # Project configuration
├── .env                        # Secrets (generated by npm run setup)
├── tenant-template/
│   └── docker-compose.yml      # Template for tenant containers
├── tenants/                    # Created automatically per tenant
│   ├── tenant-a/
│   │   ├── docker-compose.yml
│   │   ├── .env                # Tenant-specific config
│   │   └── shared.env          # Global + override env vars
│   └── tenant-b/
│       ├── docker-compose.yml
│       ├── .env
│       └── shared.env
├── data/
│   ├── admin-users.json        # Admin user list
│   ├── env-vars.json           # Global environment variables
│   ├── tenant-env-overrides.json  # Per-tenant env var overrides
│   └── audit.log               # Audit log (JSON lines)
└── scripts/
    ├── setup.ts                # Setup wizard
    └── update.sh               # SSH update script
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
