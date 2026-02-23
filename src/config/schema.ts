import { z } from 'zod';

// Database configuration schema
export const DatabaseConfigSchema = z.object({
  type: z.enum(['mysql', 'mariadb', 'postgres']).describe('Database engine type'),
  host: z.string().describe('Database hostname or container name'),
  port: z.number().default(3306).describe('Database port'),
  root_user: z.string().default('root').describe('Database root/admin username'),
  root_password_env: z.string().default('MYSQL_ROOT_PASSWORD').describe('Environment variable containing the database root password'),
  container_name: z.string().describe('Docker container name for the database'),
});

// Monitoring configuration
export const MonitoringConfigSchema = z.object({
  enabled: z.boolean().default(true).describe('Enable container monitoring'),
  metrics_interval: z.number().default(15).describe('Metrics collection interval in seconds'),
  metrics_retention: z.number().default(3600).describe('Metrics retention period in seconds'),
});

// Retention configuration for log files
export const RetentionConfigSchema = z.object({
  max_alert_entries: z.number().default(10000).describe('Maximum number of alert history entries to keep'),
  max_audit_entries: z.number().default(10000).describe('Maximum number of audit log entries to keep'),
});

// Alert rule condition
export const AlertConditionSchema = z.object({
  type: z.enum(['container_down', 'cpu_threshold', 'memory_threshold', 'health_check_failed']).describe('Type of condition that triggers the alert'),
  duration: z.string().optional().describe('Duration the condition must persist (e.g. 1m, 5m)'),
  threshold: z.number().optional().describe('Threshold value for CPU/memory alerts (percentage)'),
  consecutive_failures: z.number().optional().describe('Number of consecutive failures before alerting'),
});

// Alert rule configuration
export const AlertRuleSchema = z.object({
  id: z.string().describe('Unique identifier for the alert rule'),
  name: z.string().describe('Display name for the alert'),
  condition: AlertConditionSchema.describe('Condition that triggers the alert'),
  cooldown: z.string().default('15m').describe('Minimum time between repeated alerts'),
  severity: z.enum(['info', 'warning', 'critical']).default('warning').describe('Alert severity level'),
});

// Credentials configuration (global defaults)
export const CredentialsSchema = z.object({
  db_password_length: z.number().default(32).describe('Length of auto-generated database passwords'),
  jwt_secret_length: z.number().default(64).describe('Length of auto-generated JWT secrets'),
});

// Networking configuration
export const NetworkingSchema = z.object({
  external_network: z.string().describe('Shared Docker network name for inter-service communication'),
  internal_network_template: z.string().default('${prefix}-${tenantId}-internal').describe('Template for tenant-specific internal network names'),
  apps_path: z.string().optional().describe('Path where app/tenant directories are stored'),
});

// Main Overwatch configuration schema (slimmed — infrastructure only)
export const OverwatchConfigSchema = z.object({
  project: z.object({
    name: z.string().describe('Project display name'),
    prefix: z.string().describe('Prefix for Docker containers and networks'),
    db_prefix: z.string().describe('Prefix for database names and users'),
  }).describe('Project identification'),
  database: DatabaseConfigSchema.describe('Database connection configuration'),
  credentials: CredentialsSchema.optional().describe('Auto-generated credential settings'),
  networking: NetworkingSchema.optional().describe('Docker networking configuration'),
  monitoring: MonitoringConfigSchema.optional().describe('Container monitoring configuration'),
  alert_rules: z.array(AlertRuleSchema).optional().describe('Alert rules for monitoring'),
  retention: RetentionConfigSchema.optional().describe('Log retention configuration'),
  data_dir: z.string().optional().describe('Path to the Overwatch data directory'),
});

// TypeScript types derived from schemas
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;
export type OverwatchConfig = z.infer<typeof OverwatchConfigSchema>;

// ─── Legacy schemas (kept for migration from old format) ────────────────────

export const RegistryAuthSchema = z.object({
  type: z.enum(['token', 'basic', 'aws_iam']),
  username_env: z.string().optional(),
  token_env: z.string().optional(),
  aws_region_env: z.string().optional(),
});

export const RegistryConfigSchema = z.object({
  type: z.enum(['ghcr', 'dockerhub', 'ecr', 'custom']),
  url: z.string(),
  repository: z.string(),
  auth: RegistryAuthSchema,
  tag_pattern: z.string().optional(),
});

export const HealthCheckSchema = z.object({
  type: z.enum(['http', 'tcp']).default('http'),
  path: z.string().optional(),
  port: z.number().optional(),
  interval: z.string().default('30s'),
});

export const BackupPathSchema = z.object({
  container: z.string(),
  local: z.string(),
});

export const ServiceBackupSchema = z.object({
  enabled: z.boolean().default(false),
  paths: z.array(BackupPathSchema).optional(),
});

export const ServiceConfigSchema = z.object({
  name: z.string(),
  required: z.boolean().default(false),
  is_init_container: z.boolean().default(false),
  image_suffix: z.string(),
  ports: z.object({
    internal: z.number(),
    external: z.number().optional(),
  }).optional(),
  health_check: HealthCheckSchema.optional(),
  backup: ServiceBackupSchema.optional(),
  command: z.array(z.string()).optional(),
  env_mapping: z.record(z.string()).optional(),
});

export const BackupS3Schema = z.object({
  endpoint_env: z.string().optional(),
  endpoint_template: z.string().optional(),
  bucket_env: z.string().optional(),
  access_key_env: z.string().optional(),
  secret_key_env: z.string().optional(),
});

export const BackupConfigSchema = z.object({
  enabled: z.boolean().default(true),
  schedule: z.string().optional(),
  provider: z.enum(['s3', 'local', 'azure', 'gcs']).default('s3'),
  s3: BackupS3Schema.optional(),
  restic_password_env: z.string().default('RESTIC_PASSWORD'),
});

export const TenantTemplateSchema = z.object({
  dir: z.string().default('./tenant-template'),
  compose_file: z.string().default('docker-compose.yml'),
  env_template: z.string().default('.env.template'),
});

export const AdminAccessSchema = z.object({
  enabled: z.boolean().default(false),
  url_template: z.string().default('https://${domain}/admin-login?token=${token}'),
  secret_env: z.string().default('AUTH_SERVICE_SECRET'),
  token_payload: z.object({
    admin_flag: z.string().default('isSystemAdmin'),
    email_template: z.string().default('admin@overwatch.local'),
    name: z.string().default('System Admin'),
  }).optional(),
});

// Legacy full config schema (for migration detection)
export const LegacyOverwatchConfigSchema = z.object({
  project: z.object({
    name: z.string(),
    prefix: z.string(),
    db_prefix: z.string(),
  }),
  database: DatabaseConfigSchema,
  registry: RegistryConfigSchema,
  services: z.array(ServiceConfigSchema),
  backup: BackupConfigSchema.optional(),
  tenant_template: TenantTemplateSchema.optional(),
  credentials: CredentialsSchema.optional(),
  networking: z.object({
    external_network: z.string(),
    internal_network_template: z.string().optional(),
    tenants_path: z.string().optional(),
  }).optional(),
  admin_access: AdminAccessSchema.optional(),
  monitoring: MonitoringConfigSchema.optional(),
  alert_rules: z.array(AlertRuleSchema).optional(),
  data_dir: z.string().optional(),
});

export type LegacyOverwatchConfig = z.infer<typeof LegacyOverwatchConfigSchema>;
export type RegistryConfig = z.infer<typeof RegistryConfigSchema>;
export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;
export type BackupConfig = z.infer<typeof BackupConfigSchema>;
