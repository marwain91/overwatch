# Deployment

## Docker Compose (Recommended)

Overwatch's own compose file is generated, not hand-written. Configure `traefik.overwatch` (host, cert resolver, middlewares) in `overwatch.yaml`, then run:

```bash
overwatch infra deploy --dry-run   # print what would be written
overwatch infra deploy             # write the files and `docker compose up -d` the infrastructure stack
```

`overwatch init` writes the same files through the same renderer, so both paths produce an identical stack. The generated `overwatch/docker-compose.yml` has this shape (see the generated file for the full environment list):

```yaml
services:
  overwatch:
    image: ghcr.io/marwain91/overwatch:latest
    container_name: myapp-overwatch
    restart: unless-stopped
    environment:
      JWT_SECRET: ${JWT_SECRET}
      GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID}
      ALLOWED_ADMIN_EMAILS: ${ALLOWED_ADMIN_EMAILS:-}
      # ... database password, registry, restic/R2 settings: see the generated file
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /root/.docker:/root/.docker:ro
      - ./overwatch.yaml:/app/overwatch.yaml      # read-write: the UI/API persist Traefik edits
      - ./data:/app/data
      - /opt/myapp/deploy/apps:/app/apps
    networks:
      - shared
    # traefik.* labels are generated from overwatch.yaml -> traefik.overwatch
networks:
  shared:
    name: myapp-network
    external: true
```

> **Note:** The `/root/.docker` mount shares the host's Docker registry credentials, but Overwatch can read it only when it runs as root (`OVERWATCH_UID=0`); with the default runtime user it is not used. For private registries, set the app's registry `token_env` so Overwatch logs in itself before each pull (see [configuration.md](configuration.md)). If your registry doesn't require authentication, you can omit the mount. When using Traefik, you don't need `ports:` — Traefik routes traffic via the shared Docker network.

## Network Requirements

Overwatch needs access to:

1. **Docker socket** (`/var/run/docker.sock`) — for container management
2. **Database container** — on the same Docker network
3. **Apps directory** — mounted volume for tenant compose files
4. **Reverse proxy** (Traefik, nginx, etc.) — shares the Docker network for routing

## Client IPs behind the reverse proxy

Per-IP rate limits and the audit log use the client address from `X-Forwarded-For`, which only the reverse proxy may set. Every tenant container shares the Docker network with Overwatch, so a compromised tenant could otherwise connect to `overwatch:3002` directly with a forged header, slip past the per-IP limits (including `/oauth/register`) and fake audit IPs.

| `OVERWATCH_TRUST_PROXY` | Behaviour |
|---|---|
| unset or `1` (default) | One hop, **pinned to the Traefik container**: `X-Forwarded-For` is honoured only on connections whose peer address is what `OVERWATCH_TRUST_PROXY_HOST` resolves to (default `<project.prefix>-traefik`, the container name `overwatch infra deploy` gives Traefik). The name is re-resolved every 30 s, and at once when another peer sends the header, so a Traefik restart with a new address is followed. |
| `2`, `3`, ... | Same, with that many hops; the first hop must still be Traefik (for a CDN or load balancer in front of Traefik). |
| IP, CIDR or list (`172.18.0.0/16`, `10.0.0.5, loopback`) | Trusted exactly as given; nothing is resolved. |
| `true` | Every hop from every peer is trusted. Avoid on a shared network. |
| `false` / `0` | `X-Forwarded-For` is ignored; requests are keyed by the socket peer. |

`OVERWATCH_TRUST_PROXY_HOST` names the proxy to resolve; `none` turns pinning off and trusts the hop from any peer (the behaviour before this change).

If the proxy name cannot be resolved (for example Overwatch started before Traefik, or no Traefik container exists), Overwatch logs `[proxy-trust] WARNING: cannot resolve the reverse proxy ...` and falls back to the previous behaviour (trust the hop from any peer) until a later lookup succeeds. It never falls back to keying every request by the proxy's own address, which would put all admins in one rate-limit bucket.

When a peer other than the proxy sends `X-Forwarded-For`, Overwatch ignores the header and logs `[proxy-trust] Ignoring X-Forwarded-For from <ip>` (at most once per 10 minutes per peer). If that peer is your real reverse proxy (nginx on the host, a second proxy, a renamed Traefik container), set `OVERWATCH_TRUST_PROXY` to its IP/CIDR or `OVERWATCH_TRUST_PROXY_HOST` to its DNS name; until then all requests through it share one rate-limit bucket.

## Volume Mounts

| Mount | Description |
|-------|-------------|
| `/var/run/docker.sock` | Docker socket for container management |
| `/root/.docker:ro` | Host registry credentials, read only when Overwatch runs as root (`OVERWATCH_UID=0`); optional |
| `./overwatch.yaml` | Infrastructure configuration (mounted read-write so the UI/API can save Traefik changes) |
| `./data` | Persistent data: `apps.d/`, `apps.runtime.json`, `admin-users.json`, env vars, logs |
| `./apps` | Auto-managed tenant compose files and `.env` files |

## Production Checklist

- [ ] Configure strong `JWT_SECRET` (min 32 characters)
- [ ] Set up Google OAuth and configure `GOOGLE_CLIENT_ID`
- [ ] Add initial admin emails via `ALLOWED_ADMIN_EMAILS`
- [ ] Configure database credentials
- [ ] Connect to shared Docker network (same network as database)
- [ ] For a private registry, set the app's registry `token_env` (the `/root/.docker` mount is used only when running as root)
- [ ] Configure reverse proxy (Traefik/nginx) for HTTPS
- [ ] Check the startup log for `[proxy-trust]`: it should say `X-Forwarded-For trusted only from '<prefix>-traefik'`. If it warns instead, see [Client IPs behind the reverse proxy](#client-ips-behind-the-reverse-proxy)
- [ ] Set appropriate file permissions on mounted volumes
- [ ] Set resource limits (`deploy.resources.limits`)
- [ ] Verify healthcheck endpoint responds (`/health`)

After deployment, configure apps (registry, services, backup) through the web UI.

---

## Deploying for a New Project

This guide walks through deploying Overwatch on a production server to manage a multi-tenant containerized application. It uses a **separated directory pattern** where infrastructure, Overwatch, and apps each have their own compose files.

> **Tip:** For an automated setup, use `overwatch init` instead. See [Quick Start](../README.md#quick-start).

### Prerequisites

- A server (VPS, cloud instance, etc.) with Docker and Docker Compose 2.24 or newer installed (the generated Overwatch compose file uses `env_file` with `required: false`; check with `docker compose version`)
- Your application images published to a container registry (GHCR, Docker Hub, ECR, etc.)
- A domain with DNS configured (e.g., `*.example.com` pointing to your server)
- DNS provider API credentials for wildcard SSL (e.g., Cloudflare API token)

### Directory Structure

The deployment uses a separated layout — infrastructure, Overwatch, and apps are independent compose stacks sharing a Docker network:

```
/opt/myapp/deploy/
├── infrastructure/        # Traefik reverse proxy + database (generated)
│   ├── docker-compose.yml
│   └── traefik/
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

### Step 2: Configure Overwatch

Create the Overwatch configuration file. It holds infrastructure settings only — app definitions (registry, services, backup) are configured through the web UI after deployment. The `traefik` block drives the generated Traefik and compose files.

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

traefik:
  cert_resolvers:
    # Wildcard certs via DNS challenge (Cloudflare example)
    - name: letsencrypt
      challenge: dns
      provider: cloudflare
      acme_email: admin@example.com
      env:
        CF_DNS_API_TOKEN: "${CF_DNS_API_TOKEN}"
      domain_patterns: ["*.example.com"]
    # HTTP challenge for custom tenant domains (fallback)
    - name: letsencrypt-http
      challenge: http
      acme_email: admin@example.com
  overwatch:
    host: overwatch.example.com
    cert_resolver: letsencrypt

monitoring:
  enabled: true
  metrics_interval: 15

retention:
  max_alert_entries: 10000
  max_audit_entries: 10000
```

Traefik supports [many DNS providers](https://doc.traefik.io/traefik/https/acme/#providers); list each provider's credential variables under `env` and set them in `infrastructure/.env`.

### Step 3: Generate the infrastructure and Overwatch compose files

```bash
cd /opt/myapp/deploy
overwatch infra deploy --dry-run   # review: infrastructure/ (Traefik + MariaDB 10.11) and overwatch/docker-compose.yml
```

The infrastructure stack is Traefik `v3.6` plus MariaDB `10.11` (or PostgreSQL `16` when `database.type: postgres`). `overwatch infra deploy` refuses to replace a running database with an older version, because an older server cannot open a newer data volume; pass `--allow-db-downgrade` only after restoring from a backup.

### Step 4: Environment files

**`infrastructure/.env`:**

```bash
MYSQL_ROOT_PASSWORD=<strong-password>
CF_DNS_API_TOKEN=<cloudflare-api-token>
```

**`overwatch/.env`:**

```bash
JWT_SECRET=<generate-a-strong-secret>
GOOGLE_CLIENT_ID=<your-google-oauth-client-id>
MYSQL_ROOT_PASSWORD=<same-as-infrastructure>
ALLOWED_ADMIN_EMAILS=admin@example.com
```

### Step 5: Start everything

`overwatch infra deploy` (without `--dry-run`) writes the files, creates the network and starts the infrastructure stack. Boot order matters — infrastructure must be running before Overwatch starts:

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
│   ├── docker-compose.yml        # Traefik + MariaDB (generated)
│   └── .env                      # CF_DNS_API_TOKEN, MYSQL_ROOT_PASSWORD
├── overwatch/
│   ├── docker-compose.yml        # Overwatch container (generated)
│   ├── overwatch.yaml            # Infrastructure configuration
│   ├── .env                      # Overwatch secrets
│   └── data/
│       ├── apps.d/               # App definitions (one file per app, managed by UI/API/CLI)
│       │   ├── kwoutr.json
│       │   └── ...
│       ├── apps.runtime.json     # Per-app runtime timestamps
│       ├── apps.trashed.json     # Soft-deleted apps (recovery bin)
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
