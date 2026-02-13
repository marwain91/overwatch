import { OverwatchConfig } from './schema';

interface ValidationError {
  category: string;
  message: string;
}

/**
 * Validate that all required environment variables are set
 * based on the overwatch.yaml configuration.
 *
 * Returns an array of validation errors. Empty array = all good.
 */
export function validateEnvironment(config: OverwatchConfig): ValidationError[] {
  const errors: ValidationError[] = [];

  // --- Core ---
  requireEnv(errors, 'core', 'JWT_SECRET');
  requireEnv(errors, 'core', 'GOOGLE_CLIENT_ID');

  // --- Database ---
  const dbPasswordEnv = config.database.root_password_env;
  requireEnv(errors, 'database', dbPasswordEnv,
    `Required by database.type "${config.database.type}" (configured as database.root_password_env)`);

  // --- Registry ---
  validateRegistry(errors, config);

  // --- Backup ---
  if (config.backup?.enabled) {
    validateBackup(errors, config);
  }

  return errors;
}

function validateRegistry(errors: ValidationError[], config: OverwatchConfig): void {
  const auth = config.registry.auth;
  const type = config.registry.type;

  switch (type) {
    case 'ghcr':
      if (auth.token_env) {
        requireEnv(errors, 'registry', auth.token_env,
          `Required for GHCR authentication (configured as registry.auth.token_env)`);
      } else {
        errors.push({ category: 'registry', message: 'GHCR registry requires registry.auth.token_env to be set in overwatch.yaml' });
      }
      break;

    case 'dockerhub':
      if (auth.username_env) {
        requireEnv(errors, 'registry', auth.username_env,
          `Required for Docker Hub authentication (configured as registry.auth.username_env)`);
      }
      if (auth.token_env) {
        requireEnv(errors, 'registry', auth.token_env,
          `Required for Docker Hub authentication (configured as registry.auth.token_env)`);
      }
      if (!auth.username_env || !auth.token_env) {
        errors.push({ category: 'registry', message: 'Docker Hub registry requires both registry.auth.username_env and registry.auth.token_env in overwatch.yaml' });
      }
      break;

    case 'ecr':
      if (auth.token_env) {
        requireEnv(errors, 'registry', auth.token_env,
          `Required for ECR authentication (AWS secret key, configured as registry.auth.token_env)`);
      }
      if (auth.username_env) {
        requireEnv(errors, 'registry', auth.username_env,
          `Required for ECR authentication (AWS access key, configured as registry.auth.username_env)`);
      }
      if (auth.aws_region_env) {
        requireEnv(errors, 'registry', auth.aws_region_env,
          `Required for ECR authentication (configured as registry.auth.aws_region_env)`);
      }
      break;

    case 'custom':
      // Custom registries may or may not need auth
      if (auth.token_env) {
        requireEnv(errors, 'registry', auth.token_env,
          `Required for custom registry authentication (configured as registry.auth.token_env)`);
      }
      if (auth.username_env) {
        requireEnv(errors, 'registry', auth.username_env,
          `Required for custom registry authentication (configured as registry.auth.username_env)`);
      }
      break;
  }
}

function validateBackup(errors: ValidationError[], config: OverwatchConfig): void {
  const backup = config.backup!;

  requireEnv(errors, 'backup', backup.restic_password_env,
    `Required for Restic backup encryption (configured as backup.restic_password_env)`);

  if (backup.provider === 's3' && backup.s3) {
    const s3 = backup.s3;

    if (!s3.endpoint_template && !s3.endpoint_env) {
      errors.push({ category: 'backup', message: 'S3 backup requires either backup.s3.endpoint_template or backup.s3.endpoint_env in overwatch.yaml' });
    }

    if (s3.endpoint_env) {
      requireEnv(errors, 'backup', s3.endpoint_env,
        `Required for S3 backup endpoint (configured as backup.s3.endpoint_env)`);
    }
    if (s3.bucket_env) {
      requireEnv(errors, 'backup', s3.bucket_env,
        `Required for S3 backup bucket (configured as backup.s3.bucket_env)`);
    }
    if (s3.access_key_env) {
      requireEnv(errors, 'backup', s3.access_key_env,
        `Required for S3 backup authentication (configured as backup.s3.access_key_env)`);
    }
    if (s3.secret_key_env) {
      requireEnv(errors, 'backup', s3.secret_key_env,
        `Required for S3 backup authentication (configured as backup.s3.secret_key_env)`);
    }
  }
}

function requireEnv(errors: ValidationError[], category: string, envVar: string, hint?: string): void {
  if (!process.env[envVar]) {
    const message = hint
      ? `Missing environment variable: ${envVar} — ${hint}`
      : `Missing environment variable: ${envVar}`;
    errors.push({ category, message });
  }
}

/**
 * Format validation errors for console output.
 */
export function formatValidationErrors(errors: ValidationError[]): string {
  const grouped = new Map<string, string[]>();
  for (const err of errors) {
    const list = grouped.get(err.category) || [];
    list.push(err.message);
    grouped.set(err.category, list);
  }

  const lines: string[] = ['', 'Configuration validation failed:', ''];
  for (const [category, messages] of grouped) {
    lines.push(`  [${category}]`);
    for (const msg of messages) {
      lines.push(`    - ${msg}`);
    }
    lines.push('');
  }

  lines.push('Check your .env file and overwatch.yaml configuration.');
  return lines.join('\n');
}
