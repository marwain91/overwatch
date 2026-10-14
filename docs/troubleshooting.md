# Troubleshooting

## Tenants Not Showing

**Symptom:** Dashboard shows 0 tenants but tenant directories exist.

**Solution:** Check that `networking.apps_path` in config matches the mounted volume path. The path inside the container must match where app/tenant directories actually exist (default: `/app/apps`).

## Database Connection Failed

**Symptom:** "Failed to connect to database" or `getaddrinfo ENOTFOUND` error.

**Solutions:**
1. Verify Overwatch is on the same Docker network as the database
2. Check `database.host` matches the database container name
3. Verify root password environment variable is set correctly
4. Check database container is running and healthy

## Startup Refuses JWT_SECRET

**Symptom:** Overwatch exits at startup with `JWT_SECRET is still a documented placeholder`.

**Cause:** `JWT_SECRET` is still `replace-with-at-least-32-random-characters` from `.env.example` (or `dev-secret-at-least-32-characters` from older development docs). That value is public, so anyone could forge sessions, and Overwatch refuses to run with it (since v1.7.2).

**Solution:** Generate a secret (`openssl rand -hex 32`), set it as `JWT_SECRET` in `.env`, and restart. Every existing session is invalidated, so admins sign in again.

## Registry Authentication Failed

**Symptom:** "Failed to login to registry" or tag fetching fails.

**Solutions:**
1. Verify registry credentials environment variables are set (check the app's registry config — names live in `auth.*_env` and `api_url`).
2. **GHCR:** use a service-account PAT with `read:packages`; add `repo` when tag listing must inspect a private source repository. `github_app` auth was removed in v1.6.7 because GHCR does not honor App tokens for private/internal packages.
3. **GitLab:** token needs `read_api` + `read_registry`. Group Access Tokens are recommended for org repos. Self-hosted? Set `api_url` to the GitLab web URL (registry host and API host commonly differ). Full guide: [registry-gitlab.md](./registry-gitlab.md).
4. **GitLab self-hosted on a private network:** the SSRF guard refuses RFC1918 / loopback addresses. Set `OVERWATCH_ALLOW_PRIVATE_REGISTRY_URL=1` if intentional.
5. **ECR:** AWS credentials need ECR pull permissions.
6. **Docker Hub:** use an access token, not the account password.
7. Hit the app settings page → "Test Registry" — the response surfaces the exact failure mode (401 / 404 / network).

## Backup Repository Locked

**Symptom:** "Repository is already locked" error.

**Solution:** Use the "Unlock" button in the Backups section, or call `POST /api/apps/:appId/backups/unlock`. This removes stale locks from interrupted operations.

## Operator Log Lines and Failure Modes

Messages you may see in `docker logs overwatch`, and what they mean.

- **`[traefik] dropped raw label "<key>" on <router>: <reason>`** — a service's `raw_labels` entry addresses something other than the tenant's own routers, services or middlewares (L4 labels, other tenants' objects, `forwardauth` / `chain` / `plugin` middlewares, `tls.*`, ...). The label is not emitted. Fix the label or use the typed field; see [traefik.md](./traefik.md). Saving such labels through the API or `overwatch apps apply` returns 400.
- **`[manifest] ignored protected fields from image <tag>: <paths>`** — the image's `/overwatch/app.json` tried to change `admin_access`, `backup`, `credentials`, `db_prefix`, `traefik` or a service's `user`, `command`, `volumes`, `networks`, `backup` or routing security fields. They keep the admin-set value. Change them in Overwatch (UI, `PUT /api/apps/:id`, `overwatch apps apply`). See [updating.md](./updating.md).
- **`Tenant '<id>' is busy` / `Resource '<key>' is busy: another operation has held it for over 30s` (HTTP 409)** — another operation holds the lock on a tenant or data file. Lock files left by a dead or restarted Overwatch process are reclaimed automatically, so this usually means a genuinely long-running operation (an image pull or migration). Retry once it finishes; if it persists, check for a stuck `docker compose` or restic process. The wait is 30 seconds by default (`OVERWATCH_LOCK_TIMEOUT_MS`).
- **`[<log>] <file> cannot be replaced by rename (...); pruning by rewriting it in place`** — warning only. The audit log or alert history file is bind-mounted on its own, so retention pruning rewrites it in place instead of via rename. Mount the `data/` directory instead of single files to avoid it.
- **Tenant creation fails with 409 `A database for tenant '<id>' already exists on the database server`** — Overwatch never adopts a database it did not create. Drop or rename the existing database, then retry.
- **Tenant creation fails with `Domain "<domain>" is not allowed` (400) or `is already used by another tenant` (409)** — the domain is the Overwatch, MCP or Traefik dashboard host, or a domain or alias of another tenant. Pick a different domain.
- **`Cannot check host aliases: ... could not be read`** (500) — the alias check fails closed when tenant or app data cannot be read; fix the file permissions or corruption named in the message.
- **`docker compose` pull/up for a tenant times out** — `compose up` and `pull` are bounded at 1 hour; other compose and restic calls have shorter limits.

## Container Health Shows Unhealthy

**Symptom:** Tenant shows as unhealthy despite containers running.

**Solutions:**
1. Check container logs for application errors
2. Verify health check paths in the app's service configuration match your application
3. Check database connectivity from tenant containers
4. Ensure required services are correctly marked in the app configuration

## Tenant Update Fails on the Init Container

**Symptom:** A tenant update reports FAILED with `service "migrator" didn't complete successfully: exit N`, followed by the init container's log tail. The tenant is rolled back to its previous tag and image.

**This is working as intended** — the migration failed, so the dependent services were never started against a schema that wasn't migrated. Before v1.7.1 the same failure was silent: the init container died, the backend started anyway, and the deploy looked successful.

**Solutions:**
1. Read the attached init container logs — the exit code and the last 50 log lines are included in the failure. `exit 127` is typically a missing binary in the image (e.g. `sh: drizzle-kit: not found`), not a bad migration.
2. Fix the image or the migration, then re-run the update. The tenant stays on its previous working tag in the meantime.
3. **If the migration succeeded but the re-run fails**, the init container is not idempotent. Compose starts a completed init container again on every `up`, so a migration runner must be safe to re-run and exit 0 when there is nothing to do. See [configuration.md](./configuration.md#init-containers-and-depends_on).
4. To inspect state by hand: `docker ps -a | grep <app>-<tenant>-` — an init container in `Exited (0)` is healthy; any non-zero exit blocks its dependents.

## Google OAuth Not Working

**Symptom:** "Google OAuth not configured" error or login fails.

**Solutions:**
1. Verify `GOOGLE_CLIENT_ID` environment variable is set
2. Check Google Cloud Console for correct OAuth client configuration
3. Ensure authorized JavaScript origins include your Overwatch URL
4. Verify authorized redirect URIs are configured

## Access Token Generation Failed

**Symptom:** "Admin access not configured" when clicking Access button.

**Solutions:**
1. Set the secret environment variable referenced in the app's `admin_access.secret_env`
2. Ensure `admin_access.enabled: true` in the app configuration
3. Verify the `url_template` is correct for your application

## Health Endpoint Returns 500

**Symptom:** `/api/status/health` returns 500 with connection errors.

**Solution:** This usually means Overwatch can't reach the database. Ensure the Overwatch container is on the same Docker network as the database container:

```bash
docker network connect myapp-network overwatch-container-name
```

Or add the network in your `docker-compose.yml`.
