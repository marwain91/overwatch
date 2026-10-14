// ─── API contract types ───────────────────────────────────────────────────
// Generated from the backend Zod schemas (scripts/gen-ui-types.mjs); never hand-copy
// them here. Hand-written types below are UI-only or describe ad-hoc route payloads.
import type { AdminRole, AdminUser as ApiAdminUser, EnvVar, LockInfo } from './api-types.generated';

export type {
  AdminRole,
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
  CreateApp,
  Entrypoint,
  EnvVar,
  LockInfo,
  MiddlewareSpec,
  NotificationChannel,
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

// Tenant
export interface Tenant {
  tenantId: string;
  appId: string;
  domain: string;
  version: string;
  healthy: boolean;
  runningContainers: number;
  totalContainers: number;
  containers: ContainerInfo[];
}

export interface ContainerInfo {
  id: string;
  name: string;
  state: string;
  status: string;
  image: string;
  created: string;
  service: string;
}

// Env Vars
export interface TenantEnvVar extends EnvVar {
  source: 'global' | 'override' | 'tenant-only';
}

// Monitoring
export interface ContainerMetrics {
  name: string;
  appId: string;
  tenantId: string;
  service: string;
  cpuPercent: number;
  memUsage: number;
  memLimit: number;
  netRx: number;
  netTx: number;
}

export interface TenantMetrics {
  tenantId: string;
  appId: string;
  containerCount: number;
  totalCpu: number;
  totalMem: number;
  totalMemLimit: number;
}

export interface MetricsSnapshot {
  containers: ContainerMetrics[];
  tenants: TenantMetrics[];
}

export interface HealthState {
  containerName: string;
  appId: string;
  tenantId: string;
  service: string;
  state: 'healthy' | 'unhealthy' | 'unknown';
  lastCheck: string | null;
}

export interface AlertEntry {
  id: string;
  ruleName: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  firedAt: string;
  resolvedAt: string | null;
}

// Audit
export interface AuditEntry {
  action: string;
  user: string;
  status: number;
  timestamp: string;
}

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
