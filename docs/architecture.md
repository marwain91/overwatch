# Architecture

```
Overwatch Instance
├── Web UI (React SPA)
│   ├── Light/Dark theme with system preference
│   ├── App management (create, configure, delete)
│   ├── Tenant lifecycle (create, update, start/stop)
│   ├── Real-time monitoring (WebSocket)
│   ├── Backup/Restore UI
│   ├── Environment variable editor
│   └── Admin user management
├── API Server (Express.js)
│   ├── Authentication (Google OAuth + JWT)
│   ├── App Management (CRUD, registry testing)
│   ├── Tenant Management (per app)
│   ├── Container Operations (via Docker API)
│   ├── Backup/Restore (via Restic, per app)
│   ├── Backup Scheduler (node-cron, per app)
│   ├── Environment Variable Management (per app)
│   ├── Real-Time Monitoring
│   │   ├── Metrics Collector (CPU/memory via Docker stats)
│   │   ├── Health Checker (HTTP/TCP checks)
│   │   ├── Alert Engine (threshold rules)
│   │   └── Docker Event Listener
│   ├── WebSocket Server (live metrics, events, alerts)
│   ├── Notification Channels (webhooks)
│   ├── Admin User Management
│   ├── Audit Logging
│   ├── Log Retention (hourly pruning)
│   ├── Rate Limiting
│   └── Compose Generator (per-tenant docker-compose)
├── Database Adapter
│   ├── MySQL/MariaDB adapter
│   └── PostgreSQL adapter
└── Registry Adapter (per app)
    ├── GHCR adapter
    ├── Docker Hub adapter
    ├── ECR adapter
    └── Custom adapter

Managed Infrastructure
├── Shared Database Engine
│   ├── {db_prefix}_{tenant1}
│   ├── {db_prefix}_{tenant2}
│   └── ...
├── Shared Docker Network
│   ├── {app1}-{tenant1}-backend
│   ├── {app1}-{tenant1}-migrator
│   ├── {app2}-{tenant1}-backend
│   └── ...
├── Reverse Proxy (Traefik) — external
└── Backup Storage (S3) — external, per app
```

## Data Flow

```
overwatch.yaml (infrastructure)     data/apps.json (runtime)
├── project (name, prefix)          ├── Apps (registry, services, backup)
├── database (host, credentials)    ├── Tenants (per app, on filesystem)
├── networking                      ├── Environment variables (per app)
├── monitoring & alert rules        ├── Admin users
├── credentials (password lengths)  └── Notification channels
└── retention
```

- **Infrastructure config** (`overwatch.yaml`) is set at deployment — project name, database, networking, monitoring rules
- **App definitions** are created through the UI/API and stored in `data/apps.json`
- **Tenant data** (compose files, `.env`) is generated on the filesystem under `apps/{appId}/tenants/{tenantId}/`

## Project Structure

```
overwatch/
├── src/
│   ├── index.ts                  # Express app entry point
│   ├── cli.ts                    # CLI entry point (command routing)
│   ├── version.ts                # Version from package.json
│   ├── config/
│   │   ├── schema.ts             # Zod validation schemas (with .describe() metadata)
│   │   ├── loader.ts             # Config file loader + env resolver
│   │   ├── validate.ts           # Startup environment validation
│   │   └── index.ts              # Config exports
│   ├── cli/
│   │   ├── init.ts               # Interactive setup wizard
│   │   ├── lifecycle.ts          # start, stop, restart, status, recreate
│   │   ├── update.ts             # Docker image update
│   │   ├── self-update.ts        # CLI binary self-update
│   │   ├── admins.ts             # CLI admin user management
│   │   └── config/               # Config browser subcommands
│   │       ├── index.ts          # Interactive menu / routing
│   │       ├── view.ts           # config view
│   │       ├── edit.ts           # config edit
│   │       ├── docs.ts           # config docs
│   │       ├── validate.ts       # config validate
│   │       └── utils.ts          # Shared config utilities
│   ├── models/
│   │   └── app.ts                # App Zod schema + types
│   ├── adapters/
│   │   ├── database/             # MySQL/MariaDB, PostgreSQL adapters
│   │   │   ├── types.ts          # DatabaseAdapter interface
│   │   │   ├── mysql.ts          # MySQL/MariaDB implementation
│   │   │   ├── postgres.ts       # PostgreSQL implementation
│   │   │   └── index.ts          # Factory function
│   │   └── registry/             # GHCR, Docker Hub, ECR adapters
│   │       ├── types.ts          # RegistryAdapter interface
│   │       ├── ghcr.ts           # GitHub Container Registry
│   │       ├── dockerhub.ts      # Docker Hub
│   │       ├── ecr.ts            # Amazon ECR
│   │       ├── custom.ts         # Custom registries
│   │       └── index.ts          # Factory function
│   ├── services/
│   │   ├── index.ts              # Service barrel exports
│   │   ├── app.ts                # App CRUD (data/apps.json)
│   │   ├── tenant.ts             # Tenant CRUD operations
│   │   ├── docker.ts             # Container management (Docker API)
│   │   ├── dockerEvents.ts       # Docker event stream listener
│   │   ├── composeGenerator.ts   # Per-tenant docker-compose generation
│   │   ├── backup.ts             # Backup/restore with Restic
│   │   ├── scheduler.ts          # Per-app backup cron scheduler
│   │   ├── users.ts              # Admin user management
│   │   ├── envVars.ts            # Environment variable management
│   │   ├── metricsCollector.ts   # Container CPU/memory metrics
│   │   ├── healthChecker.ts      # HTTP/TCP health checks
│   │   ├── alertEngine.ts        # Alert rule evaluation
│   │   ├── eventBus.ts           # In-process event bus
│   │   ├── retention.ts          # Log file pruning (hourly cron)
│   │   ├── migration.ts          # Data migration utilities
│   │   └── fileLock.ts           # File locking for concurrent access
│   ├── routes/
│   │   ├── auth.ts               # Authentication endpoints
│   │   ├── apps.ts               # App CRUD + registry testing endpoints
│   │   ├── tenants.ts            # Tenant endpoints (app-scoped)
│   │   ├── status.ts             # System status endpoints
│   │   ├── backups.ts            # Backup endpoints (app-scoped)
│   │   ├── monitoring.ts         # Monitoring + notification endpoints
│   │   ├── envVars.ts            # Environment variable endpoints (app-scoped)
│   │   ├── adminUsers.ts         # Admin user endpoints
│   │   └── auditLogs.ts          # Audit log endpoints
│   ├── middleware/
│   │   ├── auth.ts               # JWT authentication
│   │   ├── audit.ts              # Audit logging
│   │   └── rateLimit.ts          # API rate limiting
│   ├── notifications/
│   │   ├── types.ts              # Notification channel types
│   │   └── webhook.ts            # Webhook notification sender
│   ├── websocket/
│   │   ├── server.ts             # WebSocket server (metrics, events, alerts)
│   │   └── types.ts              # WebSocket message types
│   └── utils/
│       └── asyncHandler.ts       # Async route error handling
├── ui/                           # React frontend (Vite + Tailwind)
│   ├── src/
│   │   ├── main.tsx              # React entry point
│   │   ├── App.tsx               # Router setup
│   │   ├── components/
│   │   │   ├── AppShell.tsx      # Layout wrapper
│   │   │   ├── AuthGuard.tsx     # Auth route protection
│   │   │   ├── Modal.tsx         # Reusable modal
│   │   │   ├── Sidebar.tsx       # Navigation + theme toggle
│   │   │   └── TagInput.tsx      # Image tag text input + browse
│   │   ├── pages/
│   │   │   ├── LoginPage.tsx
│   │   │   ├── AppListPage.tsx
│   │   │   ├── AppCreateWizard.tsx
│   │   │   ├── AppSettingsPage.tsx
│   │   │   ├── TenantsPage.tsx
│   │   │   ├── MonitoringPage.tsx
│   │   │   ├── EnvironmentPage.tsx
│   │   │   ├── ActivityPage.tsx
│   │   │   ├── AdminsPage.tsx
│   │   │   └── tenants/
│   │   │       ├── CreateTenantModal.tsx
│   │   │       ├── UpdateTenantModal.tsx
│   │   │       ├── DeleteTenantModal.tsx
│   │   │       ├── BackupsModal.tsx
│   │   │       └── TenantEnvVarsModal.tsx
│   │   ├── hooks/
│   │   │   ├── useApps.ts        # App API hooks (React Query)
│   │   │   ├── useTenants.ts     # Tenant API hooks
│   │   │   └── useMonitoring.ts  # Monitoring API hooks
│   │   ├── stores/
│   │   │   ├── authStore.ts      # Zustand auth state
│   │   │   ├── themeStore.ts     # Zustand theme state (light/dark/system)
│   │   │   └── wsStore.ts        # WebSocket connection state
│   │   └── lib/
│   │       ├── api.ts            # Fetch wrapper with auth
│   │       ├── types.ts          # Shared TypeScript types
│   │       ├── cn.ts             # Class name utility
│   │       └── format.ts         # Formatting helpers
│   ├── index.html
│   ├── tailwind.config.js
│   ├── vite.config.ts
│   └── package.json
├── overwatch.yaml                # Main configuration
├── docker-compose.yml            # Overwatch deployment
├── Dockerfile                    # Multi-stage build (backend + UI)
└── package.json
```
