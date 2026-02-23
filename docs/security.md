# Security

## Access Control

- **Google OAuth**: Only users with Google accounts can attempt login
- **Email Allowlist**: Only emails in the admin users list can access the panel
- **JWT Sessions**: 7-day expiring tokens for session management
- **Self-removal protection**: Cannot remove yourself or the last admin
- **Rate Limiting**: API rate limiting on authentication endpoints

## Secrets Management

- Database passwords for tenants are auto-generated (configurable length via `credentials.db_password_length`)
- JWT secrets for tenants are auto-generated (configurable length via `credentials.jwt_secret_length`)
- All secrets stored in tenant `.env` files (not in database)
- Root credentials only in Overwatch's environment variables
- Registry credentials referenced by environment variable names, not stored in app config
- Backup S3 credentials referenced by environment variable names, not stored in app config

## Docker Socket Security

Mounting the Docker socket gives Overwatch full control over containers. Consider:

- Running Overwatch in an isolated network
- Using Docker socket proxy with limited permissions
- Restricting network access to the Overwatch container
- Regular security audits

## Audit Logging

All state-changing operations are logged to `data/audit.log` with:
- Timestamp
- User email
- Action type
- Resource details

Log retention is configurable via `retention.max_audit_entries` in `overwatch.yaml` (default: 10,000 entries). Logs are pruned on startup and hourly.
