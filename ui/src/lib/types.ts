// App
export interface AppDefinition {
  id: string;
  name: string;
  domain_template: string;
  registry: AppRegistry;
  services: AppService[];
  backup?: AppBackup;
  admin_access?: AppAdminAccess;
  credentials?: { db_password_length?: number; jwt_secret_length?: number };
  default_image_tag: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppRegistry {
  type: 'ghcr' | 'dockerhub' | 'ecr' | 'custom';
  url: string;
  repository: string;
  auth: {
    type: 'token' | 'aws_ecr' | 'basic';
    username_env?: string;
    token_env?: string;
    aws_region_env?: string;
  };
  tag_pattern?: string;
}

export interface AppService {
  name: string;
  required: boolean;
  is_init_container: boolean;
  image_suffix?: string;
  ports?: { internal: number; external?: number };
  health_check?: { type: string; path?: string; port?: number; interval?: number };
  backup?: { enabled: boolean; paths?: Array<{ container: string; local: string }> };
  command?: string[];
  env_mapping?: Record<string, string>;
  routing?: { enabled: boolean; path_prefix?: string; priority?: number };
  volumes?: Array<{ name: string; container_path: string }>;
  depends_on?: string[];
}

export interface AppBackup {
  enabled: boolean;
  schedule?: string;
  provider: 's3' | 'local' | 'azure' | 'gcs';
  s3?: { endpoint_env: string; bucket_env: string; access_key_env: string; secret_key_env: string };
  restic_password_env?: string;
}

export interface AppAdminAccess {
  enabled: boolean;
  url_template?: string;
  secret_env?: string;
  token_payload?: Record<string, string>;
}

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
  service: string;
}

// Env Vars
export interface EnvVar {
  key: string;
  value: string;
  sensitive: boolean;
  description?: string;
}

export interface TenantEnvVar extends EnvVar {
  source: 'global' | 'override';
}

// Monitoring
export interface ContainerMetrics {
  containerName: string;
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

export interface NotificationChannel {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  config: { url: string };
}

// Audit
export interface AuditEntry {
  action: string;
  user: string;
  status: number;
  timestamp: string;
}

// Admin
export interface AdminUser {
  email: string;
  addedAt: string;
  addedBy: string;
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
  project: { name: string; prefix: string };
  database: { type: string; host: string };
  apps: Array<{ id: string; name: string; serviceCount: number; tenantCount: number }>;
}

// Backup
export interface BackupSnapshot {
  id: string;
  shortId: string;
  time: string;
  tags: Record<string, string>;
}

export interface BackupStatus {
  configured: boolean;
  initialized: boolean;
  isLocked?: boolean;
  lockInfo?: { pid?: number; host?: string; user?: string; createdAt?: string; age?: string };
}

// Auth
export interface AuthUser {
  email: string;
  name: string;
  picture: string;
}
