import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { OverwatchConfigSchema, OverwatchConfig } from './schema';

let cachedConfig: OverwatchConfig | null = null;

/**
 * Find the overwatch.yaml config file by searching common locations.
 * Priority: OVERWATCH_CONFIG env > cwd > cwd/overwatch/ > parent dir > /opt/{name}/deploy/overwatch/
 */
export function findConfigPath(): string {
  // 1. Explicit env var
  if (process.env.OVERWATCH_CONFIG) {
    return process.env.OVERWATCH_CONFIG;
  }

  const cwd = process.cwd();
  const candidates = [
    // 2. Direct in cwd (running from inside overwatch/ dir)
    path.join(cwd, 'overwatch.yaml'),
    // 3. In overwatch/ subdir (running from deploy root)
    path.join(cwd, 'overwatch', 'overwatch.yaml'),
    // 4. Parent dir (running from a sibling dir)
    path.join(cwd, '..', 'overwatch', 'overwatch.yaml'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // 5. Scan /opt/*/deploy/overwatch/ (common init default)
  try {
    const optDirs = fs.readdirSync('/opt');
    for (const dir of optDirs) {
      const candidate = path.join('/opt', dir, 'deploy', 'overwatch', 'overwatch.yaml');
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {
    // /opt doesn't exist or isn't readable
  }

  throw new Error(
    'Configuration file not found.\n' +
    '  Searched: ./overwatch.yaml, ./overwatch/overwatch.yaml, /opt/*/deploy/overwatch/overwatch.yaml\n' +
    '  Set OVERWATCH_CONFIG env var to specify the path, or run from the deploy directory.',
  );
}

/**
 * Load and validate the Overwatch configuration from YAML file.
 * Searches common locations for overwatch.yaml (see findConfigPath).
 */
export function loadConfig(): OverwatchConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const configPath = findConfigPath();

  const fileContent = fs.readFileSync(configPath, 'utf-8');
  const rawConfig = yaml.load(fileContent);

  // Validate and parse with Zod
  const parseResult = OverwatchConfigSchema.safeParse(rawConfig);

  if (!parseResult.success) {
    const errors = parseResult.error.errors
      .map(e => `  - ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${errors}`);
  }

  cachedConfig = parseResult.data;
  return cachedConfig;
}

/**
 * Get a resolved configuration value, interpolating environment variables.
 * Supports ${ENV_VAR} and ${ENV_VAR:default} syntax.
 */
export function resolveEnvValue(template: string): string {
  return template.replace(/\$\{([^}:]+)(?::([^}]*))?\}/g, (_, envVar, defaultValue) => {
    return process.env[envVar] || defaultValue || '';
  });
}

/**
 * Load the raw YAML config without Zod parsing or defaults.
 * Useful for distinguishing explicitly set values from defaults.
 */
export function loadRawConfig(): Record<string, any> {
  const configPath = findConfigPath();
  return yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, any>;
}

/**
 * Clear the cached configuration (useful for testing)
 */
export function clearConfigCache(): void {
  cachedConfig = null;
}

/**
 * Get the container name prefix from config
 */
export function getContainerPrefix(): string {
  return loadConfig().project.prefix;
}

/**
 * Get the database name/user prefix from config
 */
export function getDatabasePrefix(): string {
  return loadConfig().project.db_prefix;
}

/**
 * Get the list of service names from config
 */
export function getServiceNames(): string[] {
  return loadConfig().services.map(s => s.name);
}

/**
 * Get services that are required for health checks
 */
export function getRequiredServices(): string[] {
  return loadConfig().services
    .filter(s => s.required && !s.is_init_container)
    .map(s => s.name);
}

/**
 * Get services that have backup paths configured
 */
export function getBackupServices(): Array<{ name: string; paths: Array<{ container: string; local: string }> }> {
  return loadConfig().services
    .filter(s => s.backup?.enabled && s.backup?.paths?.length)
    .map(s => ({
      name: s.name,
      paths: s.backup!.paths!,
    }));
}

/**
 * Get the tenants directory path from config
 */
export function getTenantsDir(): string {
  return loadConfig().networking?.tenants_path || '/app/tenants';
}

/**
 * Get the template directory path from config
 */
export function getTemplateDir(): string {
  return loadConfig().tenant_template?.dir || './tenant-template';
}

/**
 * Get the data directory path from config
 */
export function getDataDir(): string {
  return loadConfig().data_dir || '/app/data';
}
