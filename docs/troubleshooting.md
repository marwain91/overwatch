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
