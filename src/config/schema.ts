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

// Registry auth configuration
export const RegistryAuthSchema = z.object({
  type: z.enum(['token', 'basic', 'aws_iam']).describe('Authentication method for the container registry'),
  username_env: z.string().optional().describe('Environment variable containing the registry username'),
  token_env: z.string().optional().describe('Environment variable containing the registry token or password'),
  aws_region_env: z.string().optional().describe('Environment variable containing the AWS region (ECR only)'),
});

// Registry configuration schema
export const RegistryConfigSchema = z.object({
  type: z.enum(['ghcr', 'dockerhub', 'ecr', 'custom']).describe('Container registry provider'),
  url: z.string().describe('Registry URL (e.g. ghcr.io, docker.io)'),
  repository: z.string().describe('Repository path (e.g. org/repo)'),
  auth: RegistryAuthSchema.describe('Registry authentication configuration'),
  tag_pattern: z.string().optional().describe('Tag pattern for filtering image versions'),
});

// Health check configuration
export const HealthCheckSchema = z.object({
  type: z.enum(['http', 'tcp']).default('http').describe('Health check protocol'),
  path: z.string().optional().describe('HTTP path for health checks (e.g. /health)'),
  port: z.number().optional().describe('Port to check'),
  interval: z.string().default('30s').describe('Interval between health checks'),
});

// Monitoring configuration
export const MonitoringConfigSchema = z.object({
  enabled: z.boolean().default(true).describe('Enable container monitoring'),
  metrics_interval: z.number().default(15).describe('Metrics collection interval in seconds'),
  metrics_retention: z.number().default(3600).describe('Metrics retention period in seconds'),
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

// Backup path configuration
export const BackupPathSchema = z.object({
  container: z.string().describe('Path inside the container to back up'),
  local: z.string().describe('Local directory name for the backup'),
});

// Service backup configuration
export const ServiceBackupSchema = z.object({
  enabled: z.boolean().default(false).describe('Enable backups for this service'),
  paths: z.array(BackupPathSchema).optional().describe('Paths to back up from the service container'),
});

// Service configuration schema
export const ServiceConfigSchema = z.object({
  name: z.string().describe('Service name (used in container naming)'),
  required: z.boolean().default(false).describe('Whether this service must be running for health checks to pass'),
  is_init_container: z.boolean().default(false).describe('Run once on tenant creation then exit (e.g. migrator)'),
  image_suffix: z.string().describe('Image suffix appended to registry repository'),
  ports: z.object({
    internal: z.number().describe('Container-internal port'),
    external: z.number().optional().describe('Externally mapped port'),
  }).optional().describe('Port mapping configuration'),
  health_check: HealthCheckSchema.optional().describe('Health check configuration for this service'),
  backup: ServiceBackupSchema.optional().describe('Backup configuration for this service'),
  command: z.array(z.string()).optional().describe('Override container command'),
  env_mapping: z.record(z.string()).optional().describe('Environment variable mapping (key=container var, value=source var)'),
});

// Backup S3 configuration
export const BackupS3Schema = z.object({
  endpoint_env: z.string().optional().describe('Environment variable containing the S3 endpoint URL'),
  endpoint_template: z.string().optional().describe('S3 endpoint URL template (alternative to endpoint_env)'),
  bucket_env: z.string().optional().describe('Environment variable containing the S3 bucket name'),
  access_key_env: z.string().optional().describe('Environment variable containing the S3 access key'),
  secret_key_env: z.string().optional().describe('Environment variable containing the S3 secret key'),
});

// Backup configuration schema
export const BackupConfigSchema = z.object({
  enabled: z.boolean().default(true).describe('Enable automatic backups'),
  schedule: z.string().optional().describe('Backup schedule as a cron expression'),
  provider: z.enum(['s3', 'local', 'azure', 'gcs']).default('s3').describe('Backup storage provider'),
  s3: BackupS3Schema.optional().describe('S3-compatible storage configuration'),
  restic_password_env: z.string().default('RESTIC_PASSWORD').describe('Environment variable containing the Restic encryption password'),
});

// Tenant template configuration
export const TenantTemplateSchema = z.object({
  dir: z.string().default('./tenant-template').describe('Path to the tenant template directory'),
  compose_file: z.string().default('docker-compose.yml').describe('Docker Compose filename within the template directory'),
  env_template: z.string().default('.env.template').describe('Environment template filename within the template directory'),
});

// Credentials configuration
export const CredentialsSchema = z.object({
  db_password_length: z.number().default(32).describe('Length of auto-generated database passwords'),
  jwt_secret_length: z.number().default(64).describe('Length of auto-generated JWT secrets'),
});

// Networking configuration
export const NetworkingSchema = z.object({
  external_network: z.string().describe('Shared Docker network name for inter-service communication'),
  internal_network_template: z.string().default('${prefix}-${tenantId}-internal').describe('Template for tenant-specific internal network names'),
  tenants_path: z.string().optional().describe('Path where tenant directories are stored'),
});

// Admin access configuration (for accessing tenant apps)
export const AdminAccessSchema = z.object({
  enabled: z.boolean().default(false).describe('Enable admin access to tenant applications'),
  url_template: z.string().default('https://${domain}/admin-login?token=${token}').describe('URL template for admin login links'),
  secret_env: z.string().default('AUTH_SERVICE_SECRET').describe('Environment variable containing the auth service secret'),
  token_payload: z.object({
    admin_flag: z.string().default('isSystemAdmin').describe('JWT claim key for the admin flag'),
    email_template: z.string().default('admin@overwatch.local').describe('Email address used in admin JWT tokens'),
    name: z.string().default('System Admin').describe('Display name used in admin JWT tokens'),
  }).optional().describe('JWT token payload configuration for admin access'),
});

// Main Overwatch configuration schema
export const OverwatchConfigSchema = z.object({
  project: z.object({
    name: z.string().describe('Project display name'),
    prefix: z.string().describe('Prefix for Docker containers and networks'),
    db_prefix: z.string().describe('Prefix for database names and users'),
  }).describe('Project identification'),
  database: DatabaseConfigSchema.describe('Database connection configuration'),
  registry: RegistryConfigSchema.describe('Container registry configuration'),
  services: z.array(ServiceConfigSchema).describe('List of tenant services to deploy'),
  backup: BackupConfigSchema.optional().describe('Backup configuration'),
  tenant_template: TenantTemplateSchema.optional().describe('Tenant template directory configuration'),
  credentials: CredentialsSchema.optional().describe('Auto-generated credential settings'),
  networking: NetworkingSchema.optional().describe('Docker networking configuration'),
  admin_access: AdminAccessSchema.optional().describe('Admin access to tenant applications'),
  monitoring: MonitoringConfigSchema.optional().describe('Container monitoring configuration'),
  alert_rules: z.array(AlertRuleSchema).optional().describe('Alert rules for monitoring'),
  data_dir: z.string().optional().describe('Path to the Overwatch data directory'),
});

// TypeScript types derived from schemas
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;
export type RegistryConfig = z.infer<typeof RegistryConfigSchema>;
export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;
export type BackupConfig = z.infer<typeof BackupConfigSchema>;
export type OverwatchConfig = z.infer<typeof OverwatchConfigSchema>;
