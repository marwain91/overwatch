// ─── API contract types ───────────────────────────────────────────────────
// Generated from the backend Zod schemas and source types (scripts/gen-ui-types.mjs);
// never hand-copy them here. Hand-written types below are UI-only or describe ad-hoc
// route payloads.
import type {
  AdminRole,
  AdminUser as ApiAdminUser,
  AuditEntry as ApiAuditEntry,
  EnvVar,
  LockInfo,
} from './api-types.generated';

export type {
  AccessControl,
  AdminRole,
  AlertHistoryEntry,
  AppAdminAccess,
  AppBackup,
  AppCredentials,
  AppDefinition,
  AppEnvVarDeclaration,
  AppHealthCheck,
  AppManifest,
  AppRegistry,
  AppService,
  AppServiceRouting,
  BackupSnapshot,
  CertResolver,
  CertResolverDns,
  CertResolverHttp,
  ContainerInfo,
  ContainerMetrics,
  CreateApp,
  Entrypoint,
  EnvVar,
  HealthState,
  LockInfo,
  MetricsSnapshot,
  MiddlewareSpec,
  NotificationChannel,
  TenantMetrics,
  // What the tenant list endpoints return.
  TenantStatus as Tenant,
  TlsTermination,
  TraefikApp,
  TraefikDashboard,
  TraefikGlobal,
  TraefikOverwatchRouting,
  TraefikTenant,
  WebhookConfig,
} from './api-types.generated';

// ─── Traefik UI helpers (the schemas themselves are generated above) ──────

export type MiddlewareType =
  | 'rateLimit' | 'basicAuth' | 'forwardAuth' | 'ipAllowList' | 'headers'
  | 'redirectScheme' | 'redirectRegex' | 'compress' | 'retry' | 'circuitBreaker'
  | 'replacePath' | 'replacePathRegex' | 'inFlightReq' | 'chain';

export const MIDDLEWARE_TYPES: MiddlewareType[] = [
  'rateLimit', 'basicAuth', 'forwardAuth', 'ipAllowList', 'headers',
  'redirectScheme', 'redirectRegex', 'compress', 'retry', 'circuitBreaker',
  'replacePath', 'replacePathRegex', 'inFlightReq', 'chain',
];

// Env Vars
export interface TenantEnvVar extends EnvVar {
  source: 'global' | 'override' | 'tenant-only';
}

// Audit: GET /audit-logs never returns request bodies.
export type AuditEntry = Omit<ApiAuditEntry, 'body'>;

// Admin
export interface AdminUser extends Omit<ApiAdminUser, 'role'> {
  // The API always returns the effective role (legacy records report 'admin').
  role: AdminRole;
}

// Status
export interface SystemHealth {
  database: string;
  containers: number;
  runningContainers: number;
  apps: number;
  containerDetails: Array<{ name: string; state: string }>;
}

export interface ProjectConfig {
  version: string;
  project: { name: string; prefix: string };
  database: { type: string };
  apps: Array<{ id: string; name: string; servicesCount: number; registry: { type: string }; backup: { enabled: boolean } }>;
}

// Backup
export interface BackupStatus {
  configured: boolean;
  initialized: boolean;
  isLocked?: boolean;
  lockInfo?: LockInfo;
}

export interface BackupSummary {
  configured: boolean;
  initialized: boolean;
  schedule: string | null;
  lastBackup: string | null;
  totalSnapshots: number;
  isLocked?: boolean;
  bucket?: string | null;
  endpoint?: string | null;
}

// Database Management
export interface DatabaseServerInfo {
  type: string;
  version: string;
  uptime: number;
  host: string;
  port: number;
}

export interface DatabaseServerStats {
  connections: { active: number; max: number; total: number };
  queries: { total: number; perSecond: number };
  threads: { running: number; cached: number; connected: number };
  memory: { bufferPoolSize: number; bufferPoolUsed: number };
}

export interface DatabaseDetail {
  name: string;
  sizeBytes: number;
  tableCount: number;
  isTenantDb: boolean;
}

export interface DatabaseProcess {
  id: number;
  user: string;
  database: string | null;
  host: string;
  command: string;
  time: number;
  state: string;
  query: string | null;
}

// Auth
export interface AuthUser {
  email: string;
  name: string;
  picture: string;
  /** Current role as resolved by the server (/auth/verify, login). */
  role?: AdminRole;
}
