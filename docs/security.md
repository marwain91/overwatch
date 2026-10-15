# Security

## Access Control

- **Google OAuth**: Only users with Google accounts can attempt login
- **Email Allowlist**: Only emails in the admin users list can access the panel
- **JWT Sessions**: 24-hour expiring tokens for session management
- **Self-removal protection**: Cannot remove yourself or the last admin
- **Rate Limiting**: API rate limiting on authentication and admin endpoints, keyed by client IP
- **Client IPs**: `X-Forwarded-For` is honoured only from the Traefik container (resolved by name), so a tenant on the shared Docker network cannot forge its client IP to dodge per-IP limits or fake audit IPs. See [Deployment: Client IPs behind the reverse proxy](deployment.md#client-ips-behind-the-reverse-proxy)

## Browser Hardening

- **Content Security Policy**: no inline scripts (`script-src 'self'` plus Google sign-in); the theme bootstrap is the static `/theme-init.js`. `connect-src` is `'self'` plus Google, which covers the UI's same-origin WebSocket.
- **HSTS**: `Strict-Transport-Security: max-age=31536000` on requests that reached the proxy over HTTPS (`X-Forwarded-Proto` from the trusted proxy only). Plain-HTTP installs get no HSTS header.
- **Framing**: `X-Frame-Options: DENY`; also `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.

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

All state-changing operations, web sign-ins (and refused sign-ins), and the MCP OAuth events (consent, token issuance, refresh, revocation, refresh-token reuse) are logged to `data/audit.log` with:
- Timestamp
- User email
- Action type
- Resource details

Log retention is configurable via `retention.max_audit_entries` in `overwatch.yaml` (default: 10,000 entries). Logs are pruned on startup and hourly.
