import { z } from 'zod';

// Database configuration schema
export const DatabaseConfigSchema = z.object({
  type: z.enum(['mysql', 'mariadb', 'postgres']),
  host: z.string(),
  port: z.number().default(3306),
  root_user: z.string().default('root'),
  root_password_env: z.string().default('MYSQL_ROOT_PASSWORD'),
  container_name: z.string(),
});

// Registry auth configuration
export const RegistryAuthSchema = z.object({
  type: z.enum(['token', 'basic', 'aws_iam']),
  username_env: z.string().optional(),
  token_env: z.string().optional(),
  aws_region_env: z.string().optional(),
});

// Registry configuration schema
export const RegistryConfigSchema = z.object({
  type: z.enum(['ghcr', 'dockerhub', 'ecr', 'custom']),
  url: z.string(),
  repository: z.string(),
  auth: RegistryAuthSchema,
  tag_pattern: z.string().optional(),
});

// Health check configuration
export const HealthCheckSchema = z.object({
  type: z.enum(['http', 'tcp']).default('http'),
  path: z.string().optional(),
  port: z.number().optional(),
  interval: z.string().default('30s'),
});

// Monitoring configuration
export const MonitoringConfigSchema = z.object({
  enabled: z.boolean().default(true),
  metrics_interval: z.number().default(15),
  metrics_retention: z.number().default(3600),
});

// Alert rule condition
export const AlertConditionSchema = z.object({
  type: z.enum(['container_down', 'cpu_threshold', 'memory_threshold', 'health_check_failed']),
  duration: z.string().optional(),
  threshold: z.number().optional(),
  consecutive_failures: z.number().optional(),
});

// Alert rule configuration
export const AlertRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  condition: AlertConditionSchema,
  cooldown: z.string().default('15m'),
  severity: z.enum(['info', 'warning', 'critical']).default('warning'),
});

// Backup path configuration
export const BackupPathSchema = z.object({
  container: z.string(),
  local: z.string(),
});

// Service backup configuration
export const ServiceBackupSchema = z.object({
  enabled: z.boolean().default(false),
  paths: z.array(BackupPathSchema).optional(),
});

// Service configuration schema
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

// Backup S3 configuration
export const BackupS3Schema = z.object({
  endpoint_env: z.string().optional(),
  endpoint_template: z.string().optional(),
  bucket_env: z.string().optional(),
  access_key_env: z.string().optional(),
  secret_key_env: z.string().optional(),
});

// Backup configuration schema
export const BackupConfigSchema = z.object({
  enabled: z.boolean().default(true),
  schedule: z.string().optional(),
  provider: z.enum(['s3', 'local', 'azure', 'gcs']).default('s3'),
  s3: BackupS3Schema.optional(),
  restic_password_env: z.string().default('RESTIC_PASSWORD'),
});

// Tenant template configuration
export const TenantTemplateSchema = z.object({
  dir: z.string().default('./tenant-template'),
  compose_file: z.string().default('docker-compose.yml'),
  env_template: z.string().default('.env.template'),
});

// Credentials configuration
export const CredentialsSchema = z.object({
  db_password_length: z.number().default(32),
  jwt_secret_length: z.number().default(64),
});

// Networking configuration
export const NetworkingSchema = z.object({
  external_network: z.string(),
  internal_network_template: z.string().default('${prefix}-${tenantId}-internal'),
  tenants_path: z.string().optional(),
});

// Admin access configuration (for accessing tenant apps)
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

// Main Overwatch configuration schema
export const OverwatchConfigSchema = z.object({
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
  networking: NetworkingSchema.optional(),
  admin_access: AdminAccessSchema.optional(),
  monitoring: MonitoringConfigSchema.optional(),
  alert_rules: z.array(AlertRuleSchema).optional(),
  data_dir: z.string().optional(),
});

// TypeScript types derived from schemas
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;
export type RegistryConfig = z.infer<typeof RegistryConfigSchema>;
export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;
export type BackupConfig = z.infer<typeof BackupConfigSchema>;
export type OverwatchConfig = z.infer<typeof OverwatchConfigSchema>;
