# Troubleshooting

## Tenants Not Showing

**Symptom:** Dashboard shows 0 tenants but tenant directories exist.

**Solution:** Check that `networking.tenants_path` in config matches the mounted volume path. The path inside the container must match where tenant directories actually exist.

## Database Connection Failed

**Symptom:** "Failed to connect to database" error.

**Solutions:**
1. Verify Overwatch is on the same Docker network as the database
2. Check `database.host` matches the database container name
3. Verify root password environment variable is set correctly
4. Check database container is running and healthy

## Registry Login Failed

**Symptom:** "Failed to login to registry" on startup.

**Solutions:**
1. Verify registry credentials environment variables are set
2. For GHCR: Ensure token has `read:packages` scope
3. For ECR: Ensure AWS credentials have ECR pull permissions
4. For Docker Hub: Use access token instead of password

## Backup Repository Locked

**Symptom:** "Repository is already locked" error.

**Solution:** Use the "Unlock" button in the Backups section, or call `POST /api/backups/unlock`. This removes stale locks from interrupted operations.

## Container Health Shows Unhealthy

**Symptom:** Tenant shows as unhealthy despite containers running.

**Solutions:**
1. Check container logs for application errors
2. Verify health check paths in config match your application
3. Check database connectivity from tenant containers
4. Ensure required services are correctly marked in config

## Google OAuth Not Working

**Symptom:** "Google OAuth not configured" error.

**Solutions:**
1. Verify `GOOGLE_CLIENT_ID` environment variable is set
2. Check Google Cloud Console for correct OAuth client configuration
3. Ensure authorized JavaScript origins include your Overwatch URL
4. Verify authorized redirect URIs are configured

## Access Token Generation Failed

**Symptom:** "AUTH_SERVICE_SECRET not configured" when clicking Access.

**Solutions:**
1. Set `AUTH_SERVICE_SECRET` environment variable
2. Ensure `admin_access.enabled: true` in config
3. Verify `admin_access.secret_env` matches your environment variable name
