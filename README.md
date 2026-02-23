# Overwatch

A universal, configuration-driven multi-tenant management tool for containerized applications.

Overwatch provides a web-based admin panel to manage multi-tenant deployments, including tenant lifecycle management, container operations, backups, and version updates. It supports multiple apps per instance — configure your infrastructure once, then add apps and tenants through the UI.

## Features

- **Multi-App Support**: Manage multiple applications from a single Overwatch instance
- **Tenant Management**: Create, update, delete, start, stop, and restart tenants per app
- **Container Operations**: View logs, restart containers, real-time health monitoring
- **Real-Time Monitoring**: Live CPU/memory metrics, health checks, and alert rules via WebSocket
- **Version Management**: Browse registry tags or type custom versions per tenant
- **Backup & Restore**: Per-app tenant backups using Restic (database + files), restore to existing or new tenants
- **Automated Backup Scheduling**: Per-app cron schedulers for automatic backups
- **Environment Variable Management**: Per-app global and per-tenant environment variables with override support
- **Admin User Management**: Add/remove admin users at runtime through the UI
- **Audit Logging**: Track all state-changing operations with user, action, and timestamp
- **Log Retention**: Configurable max entries for alert history and audit logs
- **Admin Access**: Generate JWT tokens for direct tenant application access (optional, per-app)
- **Google OAuth**: Secure admin panel login with email allowlist
- **Light/Dark Theme**: System-preference-aware with manual toggle
- **Self-Update**: Update both the Docker image (`overwatch update`) and the CLI binary (`overwatch self-update`)

## Supported Infrastructure

**Databases:** MySQL / MariaDB, PostgreSQL

**Container Registries:** GitHub Container Registry (GHCR), Docker Hub, Amazon ECR, Custom registries

**Backup Providers:** S3-compatible storage (AWS S3, Cloudflare R2, MinIO, etc.)

---

## Quick Start

Deploy Overwatch on a production server in under 5 minutes. Only Docker is required.

### 1. Install the CLI

```bash
# x64
curl -fsSL https://github.com/marwain91/overwatch/releases/latest/download/overwatch-linux-x64 -o /usr/local/bin/overwatch && chmod +x /usr/local/bin/overwatch

# ARM64
curl -fsSL https://github.com/marwain91/overwatch/releases/latest/download/overwatch-linux-arm64 -o /usr/local/bin/overwatch && chmod +x /usr/local/bin/overwatch
```

### 2. Run the setup wizard

```bash
overwatch init
```

The wizard walks you through project name, domain, database (MariaDB/PostgreSQL), DNS provider for SSL, Google OAuth, and optional S3 backups. Everything has sensible defaults — press Enter to accept them.

After confirming, it generates a complete deployment:

```
/opt/myapp/deploy/
├── infrastructure/           # Traefik reverse proxy + database
│   ├── docker-compose.yml
│   └── .env
├── overwatch/                # Overwatch instance
│   ├── docker-compose.yml
│   ├── overwatch.yaml
│   ├── .env
│   └── data/
└── apps/                     # Auto-managed by Overwatch
    └── {appId}/tenants/
```

### 3. Start

```bash
overwatch start
```

Open `https://overwatch.yourdomain.com` and log in with Google OAuth. Create your first app through the UI — define its registry, services, and backup settings — then start adding tenants.

> For a manual step-by-step setup without the CLI, see [Deploying for a New Project](docs/deployment.md#deploying-for-a-new-project).

## Architecture Overview

```
overwatch.yaml (infrastructure)     GUI / API (runtime)
├── project (name, prefix)          ├── Apps (registry, services, backup)
├── database (host, credentials)    ├── Tenants (per app)
├── networking                      ├── Environment variables (per app)
├── monitoring & alert rules        ├── Admin users
└── retention                       └── Notification channels
```

- **Infrastructure config** lives in `overwatch.yaml` — set once at deployment
- **App definitions** are created through the UI and stored in `data/apps.json`
- **Tenant data** (compose files, .env) is generated on the filesystem

## CLI Commands

| Command | Description |
|---------|-------------|
| `overwatch init` | Interactive setup — generates all config files |
| `overwatch start` | Start infrastructure + Overwatch |
| `overwatch stop` | Stop Overwatch + infrastructure |
| `overwatch restart` | Restart all services |
| `overwatch status` | Show service status and container health |
| `overwatch update` | Pull latest Docker image and restart |
| `overwatch update --check` | Check for image updates without applying |
| `overwatch self-update` | Update the CLI binary to the latest release |
| `overwatch self-update --check` | Check for CLI updates without applying |
| `overwatch config` | Interactive config browser (view, edit, validate, docs) |
| `overwatch config view [section]` | Show resolved configuration |
| `overwatch config edit [section]` | Edit configuration interactively |
| `overwatch config validate` | Validate config and environment setup |
| `overwatch config docs [section]` | Show available config options with descriptions |
| `overwatch --version` | Show CLI version |

---

## Documentation

| Document | Contents |
|----------|----------|
| [Configuration](docs/configuration.md) | `overwatch.yaml` schema, app definition, environment variables |
| [API Reference](docs/api.md) | REST API endpoints for apps, tenants, backups, monitoring, and admin |
| [Deployment](docs/deployment.md) | Docker Compose setup, production checklist, manual deploy guide, CI/CD workflows |
| [Updating](docs/updating.md) | Updating the Docker image and CLI binary |
| [Architecture](docs/architecture.md) | System architecture and project structure |
| [Security](docs/security.md) | Access control, secrets management, Docker socket security |
| [Development](docs/development.md) | Local development setup, building Docker images |
| [Troubleshooting](docs/troubleshooting.md) | Common issues and solutions |

---

## License

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

For bugs and feature requests, please [open an issue](https://github.com/marwain91/overwatch/issues).
