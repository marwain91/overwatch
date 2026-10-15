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
| `DEPLOY_DIR` | Auto-detected from CLI location | Path to the deployment directory (the one containing `overwatch/` and `infrastructure/`) |
| `SERVICE_NAME` | `overwatch` | Docker Compose service name to restart |
| `IMAGE` | `ghcr.io/marwain91/overwatch:latest` | Image to pull and check |

Example with overrides:

```bash
DEPLOY_DIR=/opt/myapp/deploy SERVICE_NAME=admin overwatch update
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

The self-update downloads the latest release from GitHub and atomically replaces the current binary. Supports both x64 and arm64 architectures. It refuses a download whose SHA256 does not match the `.sha256` file published with the release.

## Verifying Release Artifacts

Releases after v1.8.2 carry signed [build-provenance attestations](https://docs.github.com/en/actions/security-guides/using-artifact-attestations-to-establish-provenance-for-builds) for both CLI binaries and the container image. An attestation proves that the artifact was built by this repository's release workflow from a specific commit; the SHA256 check in `overwatch self-update` only proves the download matches what the release lists. Verify with the [GitHub CLI](https://cli.github.com/manual/gh_attestation_verify) (any machine with `gh`, logged in to GitHub):

```bash
# CLI binary, e.g. before installing or after `overwatch self-update`
gh attestation verify ./overwatch-linux-x64 --repo marwain91/overwatch \
  --signer-workflow marwain91/overwatch/.github/workflows/build.yml

# Container image: pin the exact version you deploy
gh attestation verify oci://ghcr.io/marwain91/overwatch:<version> --repo marwain91/overwatch \
  --signer-workflow marwain91/overwatch/.github/workflows/build.yml
```

A successful run prints the workflow, commit and tag the artifact was built from. Treat a failure as a reason not to deploy the artifact. For the image, verify the tag you actually run (or its `@sha256:` digest) rather than `latest`, which moves with every release.

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

The original `data/apps.json` is renamed to `data/apps.json.pre-apps.d` as the very last step (a backup already at that name is kept, and the new one gets a timestamp suffix). Until that rename, the migration counts as not done, so a run that stopped part-way can be run again:

- Every entry is checked before anything is written: it must load under the current app schema, and ids must be unique. A bad entry stops the run with a list of problems and nothing written; fix `apps.json` and run it again.
- The new `apps.d/` and `apps.runtime.json` are built in a staging directory and renamed into place.
- Files that an earlier, interrupted run left in `apps.d/` are replaced only if they are identical to their `apps.json` entry. If any was edited since (or is not in `apps.json`), the run stops without changing anything and says which files differ: keep whichever side is current (move `apps.json` aside, or the outdated files out of `apps.d/`) and run it again.

The schema version in `data/.schema-versions.json` is updated only after the migration succeeded.

### Why the manual step?

`overwatch migrate up` is the preferred upgrade path because it runs while Overwatch is stopped and leaves an explicit operator action in deployment history.

`OVERWATCH_AUTO_MIGRATE=1` is an emergency boot-time opt-in for environments where a separate CLI step is inconvenient. On legacy pre-multi-app configs, startup runs the legacy migration before the server starts. Pending schema-version migrations (including this `apps.json` split) run at startup through the same runner as `overwatch migrate up`; a failure stops the boot and leaves the migration pending. Without the variable, the server refuses to start while a migration is pending. Prefer the explicit `overwatch migrate up` step in normal operations.

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
| `infrastructure/traefik/dynamic.yml` | Global middlewares + dashboard router |
| `infrastructure/traefik/dynamic/dashboard.yml` | Removed when `traefik.dashboard` is configured (folded into `dynamic.yml`) |
| `infrastructure/mariadb/init/.gitkeep` | Placeholder for init SQL |
| `overwatch/docker-compose.yml` | Overwatch container (requires manual restart to apply) |

Install-time variables (`${PROJECT_PREFIX}`, `${NETWORK_NAME}`, `${APPS_PATH_ON_HOST}`) are substituted from `overwatch.yaml`. Everything else (`${BASE_DOMAIN}`, `${MYSQL_ROOT_PASSWORD}`, `${CF_DNS_API_TOKEN}`, …) is left untouched and resolved by Docker Compose from your `.env` at compose time.

**v1.6+**: when `traefik.cert_resolvers` is present in `overwatch.yaml`, the four Traefik-related templates above are generated from that config instead of being copied verbatim. Legacy installs (those still on `networking.cert_resolvers`) keep using the embedded static templates until they run `overwatch config traefik migrate`.

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
   - If found, keeps only the fields a manifest is allowed to change (see [What a manifest may change](#what-a-manifest-may-change)) and upserts the result into `apps.d/<appId>.json` and the tenant's snapshot, via the same logic as `overwatch apps apply`.
   - Regenerates the tenant's docker-compose.yml from the (possibly updated) app definition.
   - Runs `docker compose up -d --force-recreate --remove-orphans` — `--remove-orphans` stops containers for services the manifest dropped.

### Adding manifest support to an app's image

Convention: the manifest lives at `overwatch/app.json` in the app's repo and gets copied into the image at the same absolute path. The repo path mirrors the image path — same location on both sides, one fewer thing to remember.

In the app repo, create `overwatch/app.json` with the app definition (same shape consumed by `overwatch apps apply`, minus `createdAt` / `updatedAt`; protected fields can be left out, see below), and add this to the primary image's Dockerfile (the one producing the service with `image_suffix: backend`):

```dockerfile
COPY overwatch/app.json /overwatch/app.json
```

Or if you want to bundle related files together later:

```dockerfile
COPY overwatch /overwatch
```

Make sure `overwatch/` isn't excluded by `.dockerignore` (add `!overwatch/` if you have a broad catch-all).

### What a manifest may change

Anyone who can push a tag to the app's registry controls the manifest, and it updates the definition every tenant of the app shares. So the manifest may only describe the app's own shape. Fields that decide who can get in (route middlewares and whether a service is routed at all), where data lives and how containers run stay as an admin set them.

The manifest may change:

- `services`: add, remove and reorder them.
- Per service: `name`, `required`, `is_init_container`, `image_suffix`, `ports`, `health_check`, `env_mapping`, `depends_on`, and the routing paths: `routing.path_prefix`, `routing.additional_path_prefixes`, `routing.priority` and `routing.strip_prefix`.
- `env_vars` and `manifest`.

Protected (the manifest's value is ignored):

- `admin_access`, `backup`, `credentials`, `db_prefix` and `traefik` (the app's middleware library and default middlewares).
- Per service: `user`, `command`, `volumes`, `networks`, `backup`, `routing.middlewares`, `routing.raw_labels` and `routing.tls_termination`.
- Whether a service is routed (`routing.enabled`): a service that is routed today stays routed, and any other service stays unrouted (see below).

How protected fields are resolved:

- A protected field keeps its current value from the app definition in Overwatch. If the definition has no value for it, the manifest's value is dropped. This also applies to every protected field of a service that the manifest adds, so a new service that needs a volume, a `user`, a `command` or middlewares has to get them from an admin.
- A service that isn't routed today gets `routing.enabled: false`, whatever the manifest says. That covers a service that is new to the app definition, one without `ports.internal`, an init container, and one with `routing.enabled: false`. The manifest can still add ports or clear `is_init_container`; only the route is withheld. Otherwise a manifest could rename a service, remove it and add it back in a later release, or give a port-less service a port, and serve it without the middlewares an admin keeps on its route.
- To route such a service, enable it once: set the service's `routing.enabled` to `true` (and add any middlewares) with `overwatch apps apply <file>` or `PUT /api/apps/<appId>`, then update the tenant again. The service is reported as `services.<name>.routing.enabled` only when the manifest would have routed it.
- If the app definition no longer lists a service that this tenant still runs (a newer image on another tenant removed it), the tenant keeps its own values for that service.
- `id`, `name`, `domain_template`, `registry` and `default_image_tag` always come from the app definition in Overwatch, as before.
- A manifest can't point a route at a middleware the app lacks, because route middlewares and the app's middleware library are both protected. If a route does reference a missing middleware (for example after an admin edit), the update fails at the `config` step and rolls back, and the error names the missing middleware.
- When a manifest sets a protected field to a different value, Overwatch logs `[manifest] ignored protected fields from image <tag>: <paths>` (for example `admin_access, services.backend.volumes`) and adds the list to the `manifest` step of the tenant-update progress. A protected field the manifest leaves out is not reported.
- To change a protected field, change the app definition in Overwatch: `overwatch apps apply <file>`, `PUT /api/apps/<appId>`, or the admin UI for the fields it exposes (for example backup and admin access in App Settings). An existing tenant picks the change up on its next update to an image that carries a manifest.

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

## v1.5.5 — Per-tenant frozen app-definition snapshots

v1.5.4 pulled the app definition out of each new image on tenant update and wrote it to the global `apps.d/<id>.json`. That worked when all tenants of an app ran the same version, but left a ghost window when versions diverged — e.g. after a release that removed a service, tenants still on the older tag had containers the global definition no longer listed, and the backup scheduler (reading the global definition) would silently stop backing up data from those "now-unlisted" containers.

v1.5.5 fixes this by freezing a per-tenant copy of the app definition alongside each tenant's `.env` / `docker-compose.yml`. Each tenant's compose regeneration and backup config now read from its own snapshot — so tenants on different image versions never interfere.

### File layout

```
/opt/<prefix>/deploy/apps/<appId>/tenants/<tenantId>/
├── .env
├── shared.env
├── docker-compose.yml
└── app-definition.json   ← v1.5.5: per-tenant frozen snapshot
```

The global `data/apps.d/<id>.json` remains, now serving as:
- The "latest-seen manifest" display state for the admin UI and API listings.
- The default definition copied into `app-definition.json` when a brand-new tenant is created.
- The fallback read source for any tenant that somehow lacks a snapshot (the boot seed should prevent this).

### Upgrade behaviour

On first boot after upgrading to v1.5.5, Overwatch scans `/opt/<prefix>/deploy/apps/<appId>/tenants/<tenantId>/` for every registered app and seeds a `app-definition.json` (copy of the current global `apps.d/<appId>.json`) for any tenant that doesn't already have one. Idempotent — logged as:

```
[tenant-app-def] Seeded N tenant snapshot(s); M already present.
```

Subsequent tenant operations read this snapshot first and fall back to the global definition only if the file is missing (shouldn't happen after boot).

### What triggers a snapshot refresh

Only `updateTenant` refreshes a tenant's snapshot, and only when the new image has an embedded `/overwatch/app.json` (see v1.5.4 doc section). A tenant with no manifest in its image keeps the snapshot it was seeded with at creation/boot until explicit intervention.

For operators who need to force-align all tenants of an app to the current global definition (e.g., after editing `apps.d/<id>.json` manually), the operation is currently: `overwatch apps apply <file>` (updates global) → then call `updateTenant` on each tenant with its current tag. A dedicated `overwatch tenant reconcile` command covering this case is a likely follow-up.

## v1.5.6 — Tenant update progress UI + env-var declarations

Two related UX improvements around tenant updates.

### Progress events on tenant update

`updateTenant` now emits step-by-step progress over the existing WebSocket channel. The admin UI's Update-tenant modal subscribes to these events and renders a live step list:

| Step | Meaning |
|---|---|
| `manifest` | Extracting + applying `/overwatch/app.json` from the new image |
| `config` | Regenerating `shared.env` + `docker-compose.yml` |
| `pull` | `docker compose pull` (usually the slowest — where "image not found" errors surface) |
| `restart` | `docker compose up -d --force-recreate --remove-orphans` |

Failures are surfaced inline with the specific error (e.g. `ghcr.io/.../docs:1.3.18: not found`) instead of a generic toast. The modal's Cancel button turns into "Close (update continues in background)" once the request is inflight, letting the operator walk away without aborting.

### Declaring required env vars in the manifest

Apps can now declare the env vars they need from the operator in `overwatch/app.json`:

```json
{
  ...
  "env_vars": [
    { "key": "OPENAI_API_KEY", "description": "OpenAI key for chat completions", "sensitive": true },
    { "key": "SMTP_HOST",      "description": "SMTP relay",                       "default": "smtp.eu.mailgun.org" },
    { "key": "SMTP_PASS",      "description": "SMTP password",                    "sensitive": true }
  ]
}
```

On manifest apply (both `overwatch apps apply` and the image-embedded flow), Overwatch pre-populates the app's `env-vars.json` with every declared key that isn't already present — showing up in the Environment Variables page with the right description + sensitivity, waiting for the operator to fill in values. Existing values are never overwritten.

**Reserved keys** (auto-resolved by Overwatch: `FRONTEND_URL`, `BACKEND_URL`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_NAME`, `DB_PASSWORD`, `NODE_ENV`, `PORT`, `JWT_SECRET`, `TENANT_ID`, `TENANT_DOMAIN`, `IMAGE_TAG`, `PROJECT_PREFIX`, `SHARED_NETWORK`, `APP_ID`, `CERT_RESOLVER`, plus Node/system vars like `NODE_OPTIONS`, `PATH`, etc.) are skipped with a warning if an app mistakenly declares them — they're already provided at compose time, no operator input needed.

`default` values are convenience non-secrets only; don't put credentials there since the manifest travels inside the public-ish image.
