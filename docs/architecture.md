# Architecture

```
Overwatch Instance
├── Web UI (admin panel)
├── API Server (Express.js)
│   ├── Authentication (Google OAuth + JWT)
│   ├── Tenant Management
│   ├── Container Operations (via Docker API)
│   ├── Backup/Restore (via Restic)
│   ├── Backup Scheduler (node-cron)
│   ├── Environment Variable Management
│   ├── Admin User Management
│   ├── Audit Logging
│   ├── Rate Limiting
│   └── Registry Integration
├── Database Adapter
│   ├── MySQL/MariaDB adapter
│   └── PostgreSQL adapter
└── Registry Adapter
    ├── GHCR adapter
    ├── Docker Hub adapter
    ├── ECR adapter
    └── Custom adapter

Managed Infrastructure
├── Shared Database Engine
│   ├── myapp_tenant1
│   ├── myapp_tenant2
│   └── ...
├── Shared Docker Network
│   ├── myapp-tenant1-backend
│   ├── myapp-tenant1-frontend
│   ├── myapp-tenant2-backend
│   └── ...
├── Reverse Proxy (Traefik) - external
└── Backup Storage (S3) - external
```

## Project Structure

```
overwatch/
├── src/
│   ├── index.ts              # Express app entry point
│   ├── cli.ts                # CLI entry point (command routing)
│   ├── version.ts            # Version from package.json
│   ├── config/
│   │   ├── schema.ts         # Zod validation schemas
│   │   ├── loader.ts         # Config file loader
│   │   ├── validate.ts       # Startup environment validation
│   │   └── index.ts          # Config exports
│   ├── cli/
│   │   ├── init.ts           # Interactive setup wizard
│   │   ├── lifecycle.ts      # start, stop, restart, status
│   │   ├── update.ts         # Docker image update
│   │   ├── self-update.ts    # CLI binary self-update
│   │   └── config/           # Config browser subcommands
│   │       ├── index.ts      # Interactive menu / routing
│   │       ├── view.ts       # config view
│   │       ├── edit.ts       # config edit
│   │       ├── docs.ts       # config docs
│   │       └── validate.ts   # config validate
│   ├── adapters/
│   │   ├── database/         # MySQL/MariaDB, PostgreSQL adapters
│   │   │   ├── types.ts      # DatabaseAdapter interface
│   │   │   ├── mysql.ts      # MySQL/MariaDB implementation
│   │   │   ├── postgres.ts   # PostgreSQL implementation
│   │   │   └── index.ts      # Factory function
│   │   └── registry/         # GHCR, Docker Hub, ECR adapters
│   │       ├── types.ts      # RegistryAdapter interface
│   │       ├── ghcr.ts       # GitHub Container Registry
│   │       ├── dockerhub.ts  # Docker Hub
│   │       ├── ecr.ts        # Amazon ECR
│   │       ├── custom.ts     # Custom registries
│   │       └── index.ts      # Factory function
│   ├── services/
│   │   ├── docker.ts         # Container management
│   │   ├── tenant.ts         # Tenant CRUD operations
│   │   ├── backup.ts         # Backup/restore with Restic
│   │   ├── scheduler.ts      # Backup cron scheduler
│   │   ├── users.ts          # Admin user management
│   │   ├── envVars.ts        # Environment variable management
│   │   └── fileLock.ts       # File locking for concurrent access
│   ├── routes/
│   │   ├── auth.ts           # Authentication endpoints
│   │   ├── tenants.ts        # Tenant endpoints
│   │   ├── status.ts         # System status endpoints
│   │   ├── backups.ts        # Backup endpoints
│   │   ├── adminUsers.ts     # Admin user endpoints
│   │   ├── envVars.ts        # Environment variable endpoints
│   │   └── auditLogs.ts      # Audit log endpoints
│   ├── middleware/
│   │   ├── auth.ts           # JWT authentication
│   │   ├── audit.ts          # Audit logging
│   │   └── rateLimit.ts      # API rate limiting
│   └── utils/
│       └── asyncHandler.ts   # Async route error handling
├── public/                   # Static frontend files
├── tenant-template/          # Tenant docker-compose template
├── overwatch.yaml            # Main configuration
├── docker-compose.yml        # Overwatch deployment
├── Dockerfile                # Container image
├── scripts/
│   ├── setup.ts              # Setup wizard (npm run setup)
│   └── update.sh             # Self-update script
└── package.json
```
