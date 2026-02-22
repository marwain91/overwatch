# Security

## Access Control

- **Google OAuth**: Only users with Google accounts can attempt login
- **Email Allowlist**: Only emails in the admin users list can access
- **JWT Sessions**: 7-day expiring tokens for session management
- **Self-removal protection**: Cannot remove yourself or the last admin

## Secrets Management

- Database passwords for tenants are auto-generated (configurable length)
- JWT secrets for tenants are auto-generated (configurable length)
- All secrets stored in tenant `.env` files (not in database)
- Root credentials only in Overwatch's environment

## Docker Socket Security

Mounting the Docker socket gives Overwatch full control over containers. Consider:

- Running Overwatch in an isolated network
- Using Docker socket proxy with limited permissions
- Restricting network access to the Overwatch container
- Regular security audits
