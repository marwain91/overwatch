# Updating

## Updating the Docker Image

Use the CLI to pull the latest Overwatch image and restart:

```bash
overwatch update
```

This pulls the latest image, compares digests, and recreates the container if an update is available.

To check for updates without applying:

```bash
overwatch update --check
```

### Environment Overrides

| Variable | Default | Description |
|----------|---------|-------------|
| `DEPLOY_DIR` | Auto-detected from CLI location | Path to the deployment directory |
| `SERVICE_NAME` | `overwatch` | Docker Compose service name to restart |
| `IMAGE` | `ghcr.io/marwain91/overwatch:latest` | Image to pull and check |

Example with overrides:

```bash
DEPLOY_DIR=/opt/myapp/deploy/overwatch SERVICE_NAME=admin overwatch update
```

## Updating the CLI Binary

Update the `overwatch` CLI itself to the latest release:

```bash
overwatch self-update
```

To check for a new CLI version without applying:

```bash
overwatch self-update --check
```

The self-update downloads the latest release from GitHub and atomically replaces the current binary. Supports both x64 and arm64 architectures.

## Upgrading to v1.4.0 — apps.d/ Migration

v1.4.0 splits the single `data/apps.json` file into per-app static definitions at `data/apps.d/<id>.json` plus a `data/apps.runtime.json` sidecar for timestamps. A one-shot migration is required; it is **not** automatic on boot.

### Procedure

```bash
# 1. Stop Overwatch
docker stop overwatch

# 2. Run the migration from the host (as the deploy user, with cwd at the deploy root
#    so overwatch.yaml and data/ are discoverable).
overwatch migrate up

# 3. Start Overwatch
docker start overwatch
```

The migration is idempotent; it exits without doing anything if `data/apps.d/` is already populated. The original `data/apps.json` is renamed to `data/apps.json.pre-apps.d` as a one-time backup.

### Why the manual step?

The `OVERWATCH_AUTO_MIGRATE=1` env var **only** gates the refuse-to-boot behavior when schema migrations are pending. It does **not** execute migrations. The explicit CLI call is required.

### After migrating

Deploy pipelines should register their app via the new CLI instead of touching `data/` directly:

```bash
ssh deploy@host 'overwatch apps apply /path/to/my-app.json'
```

The file is a single-app definition — the full `AppDefinition` shape minus `createdAt`/`updatedAt`. Applying an unchanged file is a no-op (it doesn't bump `updatedAt`). Any pipeline that still `rsync`'s into `data/apps.json` or `data/apps.d/` should be replaced with `overwatch apps apply` — file-level ownership stops cross-app clobbering.

## Upgrading to v1.5.0 — Built-in Infrastructure Deploy

v1.5.0 ships the shared infrastructure templates (Traefik, MariaDB, Overwatch's own compose file) inside the Overwatch binary. The `overwatch infra deploy` command renders them onto the host and reconciles the infrastructure stack — removing the need for any app repo (previously Kwoutr's) to own those files.

### First-time cutover

If your host currently has the infra provisioned by a separate repo (rsynced files, hand-written compose, etc.), cut over as follows:

```bash
# Dry-run first to see what overwatch would write
overwatch infra deploy --dry-run

# Apply: writes templates into the deploy dir and runs docker compose up -d
# on the infrastructure stack. Overwatch's own container is not touched.
overwatch infra deploy
```

Compare diffs, resolve any conflicts (e.g., container renames), then let the compose reconcile the infrastructure. Afterwards, remove the rsync/deploy step from whichever repo was previously managing these files (e.g. `deploy-infrastructure` in an app repo).

### What gets written

The deploy command writes into `$DEPLOY_DIR/`:

| Path | Contents |
|------|----------|
| `infrastructure/docker-compose.yml` | Traefik + MariaDB stack |
| `infrastructure/traefik/traefik.yml` | Traefik static config |
| `infrastructure/traefik/dynamic.yml` | Global middlewares |
| `infrastructure/traefik/dynamic/dashboard.yml` | Dashboard router + basic-auth |
| `infrastructure/mariadb/init/.gitkeep` | Placeholder for init SQL |
| `overwatch/docker-compose.yml` | Overwatch container (requires manual restart to apply) |

Install-time variables (`${PROJECT_PREFIX}`, `${NETWORK_NAME}`, `${APPS_PATH_ON_HOST}`) are substituted from `overwatch.yaml`. Everything else (`${BASE_DOMAIN}`, `${MYSQL_ROOT_PASSWORD}`, `${CF_DNS_API_TOKEN}`, …) is left untouched and resolved by Docker Compose from your `.env` at compose time.

### What it does NOT do

- Does not modify or restart the Overwatch container (prevents self-restart loops when invoked from within).
- Does not touch `data/`, `apps/`, tenant state, or any secret.
- Does not create secrets. You maintain `$DEPLOY_DIR/.env` manually (or via whatever secret-management flow you already have).

### Redeploying

Safe to re-run any time — the command diffs templates against on-disk state and only restarts compose services when something actually changed.
