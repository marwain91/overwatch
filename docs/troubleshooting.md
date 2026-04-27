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
2. **GHCR with a PAT:** ensure the token has `read:packages` (and `repo` for tag listing on private source repos).
3. **GHCR with a GitHub App:** confirm the App is *installed* on the specific repository, has `Contents:Read`, `Metadata:Read`, and `Packages:Read`, and that `GH_APP_ID` / `GH_APP_INSTALLATION_ID` / `GH_APP_PRIVATE_KEY` are set. Full guide: [registry-github-app.md](./registry-github-app.md).
4. **GitLab:** token needs `read_api` + `read_registry`. Group Access Tokens are recommended for org repos. Self-hosted? Set `api_url` to the GitLab web URL (registry host and API host commonly differ). Full guide: [registry-gitlab.md](./registry-gitlab.md).
5. **GitLab self-hosted on a private network:** the SSRF guard refuses RFC1918 / loopback addresses. Set `OVERWATCH_ALLOW_PRIVATE_REGISTRY_URL=1` if intentional.
6. **ECR:** AWS credentials need ECR pull permissions.
7. **Docker Hub:** use an access token, not the account password.
8. Hit the app settings page → "Test Registry" — the response surfaces the exact failure mode (401 / 404 / network).

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
