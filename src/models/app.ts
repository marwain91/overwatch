import { z } from 'zod';

// Registry auth configuration for app
export const AppRegistryAuthSchema = z.object({
  type: z.enum(['token', 'basic', 'aws_iam']),
  username_env: z.string().optional(),
  token_env: z.string().optional(),
  aws_region_env: z.string().optional(),
});

// Registry configuration for app
export const AppRegistrySchema = z.object({
  type: z.enum(['ghcr', 'dockerhub', 'ecr', 'custom']),
  url: z.string(),
  repository: z.string(),
  auth: AppRegistryAuthSchema,
  tag_pattern: z.string().optional(),
});

// Health check configuration
export const AppHealthCheckSchema = z.object({
  type: z.enum(['http', 'tcp']).default('http'),
  path: z.string().optional(),
  port: z.number().optional(),
  interval: z.string().default('30s'),
  start_period: z.string().optional(),
  tool: z.enum(['wget', 'curl']).default('wget'),
});

// Backup path
export const AppBackupPathSchema = z.object({
  container: z.string(),
  local: z.string(),
});

// Service backup configuration
export const AppServiceBackupSchema = z.object({
  enabled: z.boolean().default(false),
  paths: z.array(AppBackupPathSchema).optional(),
});

// Service routing configuration
export const AppServiceRoutingSchema = z.object({
  enabled: z.boolean().default(true),
  path_prefix: z.string().optional(),
  additional_path_prefixes: z.array(z.string()).optional(),
  priority: z.number().optional(),
  strip_prefix: z.boolean().default(false),
});

// Service volume configuration
export const AppServiceVolumeSchema = z.object({
  name: z.string(),
  container_path: z.string(),
  name_template: z.string().optional(),
  external: z.boolean().optional(),
});

// Service definition within an app
export const AppServiceSchema = z.object({
  name: z.string(),
  required: z.boolean().default(false),
  is_init_container: z.boolean().default(false),
  image_suffix: z.string().optional(),
  user: z.string().optional(),
  ports: z.object({
    internal: z.number(),
    external: z.number().optional(),
  }).optional(),
  health_check: AppHealthCheckSchema.optional(),
  backup: AppServiceBackupSchema.optional(),
  command: z.array(z.string()).optional(),
  env_mapping: z.record(z.union([z.string(), z.object({ static: z.string() })])).optional(),
  routing: AppServiceRoutingSchema.optional(),
  volumes: z.array(AppServiceVolumeSchema).optional(),
  depends_on: z.array(z.string()).optional(),
  networks: z.array(z.enum(['external', 'internal'])).optional(),
});

// App-level backup configuration
export const AppBackupSchema = z.object({
  enabled: z.boolean().default(false),
  schedule: z.string().optional(),
  provider: z.enum(['s3', 'local', 'azure', 'gcs']).default('s3'),
  s3: z.object({
    endpoint_env: z.string().optional(),
    bucket_env: z.string().optional(),
    access_key_env: z.string().optional(),
    secret_key_env: z.string().optional(),
  }).optional(),
  restic_password_env: z.string().optional(),
});

// Admin access configuration
export const AppAdminAccessSchema = z.object({
  enabled: z.boolean().default(false),
  url_template: z.string().default('https://${domain}/admin-login?token=${token}'),
  secret_env: z.string().default('AUTH_SERVICE_SECRET'),
  token_payload: z.object({
    admin_flag: z.string().default('isSystemAdmin'),
    email_template: z.string().default('admin@overwatch.local'),
    name: z.string().default('System Admin'),
  }).optional(),
});

// App credentials configuration
export const AppCredentialsSchema = z.object({
  db_password_length: z.number().default(32),
  jwt_secret_length: z.number().default(64),
});

// Main app definition schema
export const AppDefinitionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/, 'Must be lowercase alphanumeric with hyphens'),
  name: z.string().min(1),
  domain_template: z.string(),
  registry: AppRegistrySchema,
  services: z.array(AppServiceSchema).min(1),
  backup: AppBackupSchema.optional(),
  admin_access: AppAdminAccessSchema.optional(),
  credentials: AppCredentialsSchema.optional(),
  default_image_tag: z.string().default('latest'),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// Schema for creating a new app (without timestamps)
export const CreateAppSchema = AppDefinitionSchema.omit({
  createdAt: true,
  updatedAt: true,
});

// Schema for updating an app (all fields optional except id)
export const UpdateAppSchema = CreateAppSchema.partial().required({ id: true });

// TypeScript types
export type AppDefinition = z.infer<typeof AppDefinitionSchema>;
export type CreateAppInput = z.infer<typeof CreateAppSchema>;
export type UpdateAppInput = z.infer<typeof UpdateAppSchema>;
export type AppService = z.infer<typeof AppServiceSchema>;
export type AppRegistry = z.infer<typeof AppRegistrySchema>;
export type AppBackup = z.infer<typeof AppBackupSchema>;
