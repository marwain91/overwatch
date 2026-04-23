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

## v1.5.4 — App definitions ride inside app images

From v1.5.4, Overwatch can pull an app's own definition out of a freshly-released image, so adding or removing a service travels atomically with the code that ships it. The app repo no longer has to SSH in or call any Overwatch API — Overwatch reads the manifest on the next tenant update.

### How it works

1. The app bakes a single file — `overwatch-app.json` — into its primary image. The default location Overwatch looks for is `/overwatch/app.json`, and the default image is the one whose `image_suffix` is `backend`. Both are overridable via an optional `manifest` section in the app definition.
2. When an operator (or an automation) calls `PATCH /api/apps/<appId>/tenants/<tenantId>` with a new `imageTag`, Overwatch:
   - Pulls the new image.
   - Extracts `/overwatch/app.json` (via throw-away `docker create` + `docker cp`).
   - If found and different from the current `apps.d/<appId>.json`, upserts via the same logic as `overwatch apps apply`.
   - Regenerates the tenant's docker-compose.yml from the (possibly updated) app definition.
   - Runs `docker compose up -d --force-recreate --remove-orphans` — `--remove-orphans` stops containers for services the manifest dropped.

### Adding manifest support to an app's image

Convention: the manifest lives at `overwatch/app.json` in the app's repo and gets copied into the image at the same absolute path. The repo path mirrors the image path — same location on both sides, one fewer thing to remember.

In the app repo, create `overwatch/app.json` with the full app definition (same shape consumed by `overwatch apps apply`, minus `createdAt` / `updatedAt`), and add this to the primary image's Dockerfile (the one producing the service with `image_suffix: backend`):

```dockerfile
COPY overwatch/app.json /overwatch/app.json
```

Or if you want to bundle related files together later:

```dockerfile
COPY overwatch /overwatch
```

Make sure `overwatch/` isn't excluded by `.dockerignore` (add `!overwatch/` if you have a broad catch-all).

### Non-invasive by default

- Apps that don't bake a manifest keep working exactly as before — the extraction returns null and Overwatch falls through to the existing on-disk definition.
- Broken JSON in the manifest doesn't block the tenant update; it logs a warning and falls through.
- The manifest upsert path uses the same trash guard as `apps apply` — if an app is soft-deleted, its manifest won't silently re-create it.

### Opting in with `manifest` config

If an app wants a non-default location or a different carrier image, add this to its `overwatch-app.json`:

```json
{
  "manifest": {
    "image_suffix": "api",
    "path": "/etc/overwatch/manifest.json"
  }
}
```
