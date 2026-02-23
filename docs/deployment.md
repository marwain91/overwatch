# Deployment

## Docker Compose (Recommended)

```yaml
services:
  overwatch:
    image: ghcr.io/marwain91/overwatch:latest
    container_name: overwatch
    restart: unless-stopped
    env_file: .env
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /root/.docker:/root/.docker:ro
      - ./overwatch.yaml:/app/overwatch.yaml:ro
      - ./data:/app/data
      - ./apps:/app/apps
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

## Network Requirements

Overwatch needs access to:

1. **Docker socket** (`/var/run/docker.sock`) — for container management
2. **Database container** — on the same Docker network
3. **Apps directory** — mounted volume for tenant compose files
4. **Reverse proxy** (Traefik, nginx, etc.) — shares the Docker network for routing

## Volume Mounts

| Mount | Description |
|-------|-------------|
| `/var/run/docker.sock` | Docker socket for container management |
| `/root/.docker:ro` | Registry credentials for pulling tenant images (optional) |
| `./overwatch.yaml:ro` | Infrastructure configuration |
| `./data` | Persistent data: `apps.json`, `admin-users.json`, env vars, logs |
| `./apps` | Auto-managed tenant compose files and `.env` files |

## Production Checklist

- [ ] Configure strong `JWT_SECRET` (min 32 characters)
- [ ] Set up Google OAuth and configure `GOOGLE_CLIENT_ID`
- [ ] Add initial admin emails via `ALLOWED_ADMIN_EMAILS`
- [ ] Configure database credentials
- [ ] Connect to shared Docker network (same network as database)
- [ ] Mount Docker credentials (`/root/.docker`) if using private registry
- [ ] Configure reverse proxy (Traefik/nginx) for HTTPS
- [ ] Set appropriate file permissions on mounted volumes
- [ ] Set resource limits (`deploy.resources.limits`)
- [ ] Verify healthcheck endpoint responds (`/health`)

After deployment, configure apps (registry, services, backup) through the web UI.

---

## Deploying for a New Project

This guide walks through deploying Overwatch on a production server to manage a multi-tenant containerized application. It uses a **separated directory pattern** where infrastructure, Overwatch, and apps each have their own compose files.

> **Tip:** For an automated setup, use `overwatch init` instead. See [Quick Start](../README.md#quick-start).

### Prerequisites

- A server (VPS, cloud instance, etc.) with Docker and Docker Compose installed
- Your application images published to a container registry (GHCR, Docker Hub, ECR, etc.)
- A domain with DNS configured (e.g., `*.example.com` pointing to your server)
- DNS provider API credentials for wildcard SSL (e.g., Cloudflare API token)

### Directory Structure

The deployment uses a separated layout — infrastructure, Overwatch, and apps are independent compose stacks sharing a Docker network:

```
/opt/myapp/deploy/
├── infrastructure/        # Traefik reverse proxy + database
│   └── docker-compose.yml
├── overwatch/             # Overwatch instance
│   ├── docker-compose.yml
│   ├── overwatch.yaml
│   ├── .env
│   └── data/
└── apps/                  # Auto-managed by Overwatch
    └── {appId}/tenants/
```

This separation means you can restart infrastructure without touching Overwatch, update Overwatch without affecting tenants, and each component has its own lifecycle.

### Step 1: Create directory structure

```bash
mkdir -p /opt/myapp/deploy/{infrastructure,overwatch,overwatch/data,apps}
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

Create the Overwatch configuration file. This only contains infrastructure settings — app definitions (registry, services, backup) are configured through the web UI after deployment.

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

networking:
  external_network: "myapp-network"
  apps_path: "/app/apps"

monitoring:
  enabled: true
  metrics_interval: 15

retention:
  max_alert_entries: 10000
  max_audit_entries: 10000
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
      - ./data:/app/data
      - ../apps:/app/apps
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

**`overwatch/.env`:**

```bash
JWT_SECRET=<generate-a-strong-secret>
GOOGLE_CLIENT_ID=<your-google-oauth-client-id>
MYSQL_ROOT_PASSWORD=<same-as-infrastructure>
ALLOWED_ADMIN_EMAILS=admin@example.com
```

### Step 5: Start everything

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

Access Overwatch at `https://overwatch.example.com`, log in with Google OAuth, and create your first app through the UI — define its registry, services, and backup settings — then start adding tenants.

### Final Directory Structure

After setting up and creating a few apps with tenants:

```
/opt/myapp/deploy/
├── infrastructure/
│   ├── docker-compose.yml        # Traefik + MariaDB
│   └── .env                      # CF_DNS_API_TOKEN, MYSQL_ROOT_PASSWORD
├── overwatch/
│   ├── docker-compose.yml        # Overwatch container
│   ├── overwatch.yaml            # Infrastructure configuration
│   ├── .env                      # Overwatch secrets
│   └── data/
│       ├── apps.json             # App definitions (managed by UI)
│       ├── admin-users.json      # Admin user list
│       ├── alert-history.jsonl   # Alert history (auto-pruned)
│       └── audit.log             # Audit log (auto-pruned)
└── apps/                         # Auto-managed by Overwatch
    ├── myapp/
    │   └── tenants/
    │       ├── acme/
    │       │   ├── docker-compose.yml    # Generated from app services
    │       │   └── .env                  # Tenant credentials + env vars
    │       └── globex/
    │           ├── docker-compose.yml
    │           └── .env
    └── otherapp/
        └── tenants/
            └── demo/
                ├── docker-compose.yml
                └── .env
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

> **Tip:** You can also use `overwatch update` on the server instead of a CI workflow. See [Updating](updating.md).
