# Overwatch

A universal, configuration-driven multi-tenant management tool for containerized applications.

## Features

- **Configuration-Driven**: Single YAML file defines your project structure
- **Multi-Database Support**: MySQL/MariaDB and PostgreSQL
- **Multi-Registry Support**: GHCR, Docker Hub, AWS ECR, and custom registries
- **Tenant Management**: Create, update, delete, start, stop, and restart tenant stacks
- **Backup & Restore**: Restic-based backups to S3-compatible storage
- **Admin Access Control**: Google OAuth authentication with admin user management
- **Container Logs**: View real-time container logs from the admin panel

## Quick Start

1. **Clone and configure**:
   ```bash
   git clone https://github.com/your-org/overwatch.git
   cd overwatch
   cp examples/overwatch.yaml.example overwatch.yaml
   # Edit overwatch.yaml with your project settings
   ```

2. **Set environment variables**:
   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   ```

3. **Run with Docker**:
   ```bash
   docker compose up -d
   ```

4. **Access admin panel**: Open `http://localhost:3002` and sign in with Google

## Configuration

Create an `overwatch.yaml` file in the project root:

```yaml
project:
  name: "MyApp"
  prefix: "myapp"
  db_prefix: "myapp"

database:
  type: "postgres"  # or "mysql", "mariadb"
  host: "myapp-postgres"
  port: 5432
  root_user: "postgres"
  root_password_env: "POSTGRES_PASSWORD"
  container_name: "myapp-postgres"

registry:
  type: "ghcr"  # or "dockerhub", "ecr", "custom"
  url: "ghcr.io"
  repository: "your-org/your-app"
  auth:
    type: "token"
    token_env: "GHCR_TOKEN"

services:
  - name: "backend"
    required: true
    image_suffix: "backend"
    health_check:
      path: "/api/health"
      port: 3001

  - name: "frontend"
    required: true
    image_suffix: "frontend"

  - name: "migrator"
    is_init_container: true
    image_suffix: "backend"
```

See `examples/` for complete configuration examples.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | Yes | Secret for signing admin JWT tokens |
| `GOOGLE_CLIENT_ID` | Yes | Google OAuth client ID |
| `MYSQL_ROOT_PASSWORD` | For MySQL | MySQL/MariaDB root password |
| `POSTGRES_PASSWORD` | For Postgres | PostgreSQL superuser password |
| `GHCR_TOKEN` | For GHCR | GitHub Container Registry token |
| `DOCKER_USERNAME` | For Docker Hub | Docker Hub username |
| `DOCKER_PASSWORD` | For Docker Hub | Docker Hub password |
| `R2_ENDPOINT` | For backups | S3-compatible endpoint URL |
| `R2_BUCKET_NAME` | For backups | Bucket name |
| `R2_ACCESS_KEY_ID` | For backups | Access key ID |
| `R2_SECRET_ACCESS_KEY` | For backups | Secret access key |
| `RESTIC_PASSWORD` | For backups | Restic repository password |

## Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run in development mode
npm run dev
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/api/auth/google` | Google OAuth login |
| `GET` | `/api/status` | System status (containers, database, backups) |
| `GET` | `/api/status/config` | Project configuration |
| `GET` | `/api/tenants` | List all tenants |
| `POST` | `/api/tenants` | Create new tenant |
| `PUT` | `/api/tenants/:id` | Update tenant |
| `DELETE` | `/api/tenants/:id` | Delete tenant |
| `POST` | `/api/tenants/:id/start` | Start tenant containers |
| `POST` | `/api/tenants/:id/stop` | Stop tenant containers |
| `POST` | `/api/tenants/:id/restart` | Restart tenant containers |
| `GET` | `/api/tenants/:id/logs` | Get container logs |
| `GET` | `/api/backups` | List all backups |
| `POST` | `/api/backups` | Create backup |
| `POST` | `/api/backups/restore` | Restore backup |
| `DELETE` | `/api/backups/:id` | Delete backup |
| `GET` | `/api/admin-users` | List admin users |
| `POST` | `/api/admin-users` | Add admin user |
| `DELETE` | `/api/admin-users/:email` | Remove admin user |

## Architecture

```
overwatch/
├── overwatch.yaml          # Project configuration
├── src/
│   ├── config/             # Configuration loader with Zod validation
│   ├── adapters/
│   │   ├── database/       # MySQL, PostgreSQL adapters
│   │   └── registry/       # GHCR, Docker Hub, ECR adapters
│   ├── services/           # Core business logic
│   │   ├── docker.ts       # Container management
│   │   ├── tenant.ts       # Tenant CRUD operations
│   │   └── backup.ts       # Backup/restore operations
│   ├── routes/             # Express route handlers
│   └── middleware/         # Auth middleware
├── public/                 # Admin panel frontend
├── tenant-template/        # Templates for new tenants
└── examples/               # Example configurations
```

## License

MIT
