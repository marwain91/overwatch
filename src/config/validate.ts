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
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
    errors.push({ category: 'core', message: 'JWT_SECRET must be at least 32 characters for adequate security' });
  }
  requireEnv(errors, 'core', 'GOOGLE_CLIENT_ID');

  // --- Database ---
  const dbPasswordEnv = config.database.root_password_env;
  requireEnv(errors, 'database', dbPasswordEnv,
    `Required by database.type "${config.database.type}" (configured as database.root_password_env)`);

  // Registry and backup validation now happens per-app at runtime

  return errors;
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
