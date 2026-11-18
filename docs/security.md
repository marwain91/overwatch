# Security

## Security updates (2026-11-18)

- The Docker base and standalone CLI runtime use Node.js 24.22.3. All Docker
  stages share a pinned digest. Runtime images omit npm and Yarn, including
  their bundled dependencies; use a development container for package tooling.
- Backend dependencies include Zod 4.6.7 and patched body-parser, Hono,
  node-server, fast-uri, qs and Undici releases recorded in `package-lock.json`.
  Partial app updates preserve an omitted image tag instead of applying a
  creation default. CI audits both backend and UI dependency trees.
- Infrastructure templates and the compose generator use Traefik 3.7.19.
  Existing installations must also redeploy their Traefik service; rebuilding
  Overwatch alone does not update the proxy.

### External nginx and nginx2root

Overwatch's image does not contain nginx. Check external TLS proxies and any
nginx instances embedded in managed applications separately. The nginx2root
fixes are in nginx 1.30.7 (stable) and 1.31.9 (mainline), or a distribution
package with explicitly documented backports. An upstream version string alone
cannot identify a backported fix.

If a patched package is unavailable, disable HTTP/2 on every applicable listener
and terminate existing HTTP/2 connections. This only mitigates the two HTTP/2
vulnerabilities: also check HTTP/3, resolver/subrequest and mail-proxy features.
On hosts that do not use SCTP, block its module with `install sctp /bin/false`
and `blacklist sctp` in `/etc/modprobe.d/`; this does not disable an already
loaded module or built-in SCTP. Keep this mitigation until a kernel fix for the
associated SCTP issue is confirmed by the distribution.

References: [nginx advisories](https://nginx.org/en/security_advisories.html),
[nginx2root research](https://xint.io/blog/nginx2root-remote-code-execution),
[Traefik advisories](https://github.com/traefik/traefik/security/advisories).

## Access Control

- **Google OAuth**: Only users with Google accounts can attempt login
- **Email Allowlist**: Only emails in the admin users list can access the panel
- **JWT Sessions**: 24-hour expiring tokens for session management. Signing out revokes the token on the server (its id is kept in `data/revoked-sessions.json` until the token would have expired), and the REST API and WebSocket reject it from then on; an open WebSocket of that session closes within a minute. Sessions issued before an upgrade to a version with server-side logout cannot be revoked and stay valid until they expire (at most 24 hours)
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

All state-changing operations, web sign-ins (and refused sign-ins), sign-outs, and the MCP OAuth events (consent, token issuance, refresh, revocation, refresh-token reuse) are logged to `data/audit.log` with:
- Timestamp
- User email
- Action type
- Resource details

Log retention is configurable via `retention.max_audit_entries` in `overwatch.yaml` (default: 10,000 entries). Logs are pruned on startup and hourly.
