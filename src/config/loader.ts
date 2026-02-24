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

/** Allowed env var name pattern — prevents access to arbitrary process vars */
const SAFE_ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * Get a resolved configuration value, interpolating environment variables.
 * Supports ${ENV_VAR} and ${ENV_VAR:default} syntax.
 * Single-pass only — resolved values are NOT re-expanded.
 */
export function resolveEnvValue(template: string): string {
  return template.replace(/\$\{([^}:]+)(?::([^}]*))?\}/g, (match, envVar, defaultValue) => {
    if (!SAFE_ENV_NAME.test(envVar)) return match; // skip invalid var names
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
 * Get the apps directory path from config.
 * This is the root directory containing app subdirectories.
 */
export function getAppsDir(): string {
  return loadConfig().networking?.apps_path || '/app/apps';
}

/**
 * Get the data directory path from config
 */
export function getDataDir(): string {
  const dir = loadConfig().data_dir || '/app/data';

  // If the path exists (inside container or custom path), use it
  if (fs.existsSync(dir)) return dir;

  // Fallback: derive from config file location (CLI running on host)
  // overwatch.yaml is at {deployDir}/overwatch/overwatch.yaml
  // data dir is at {deployDir}/overwatch/data/
  try {
    const configPath = findConfigPath();
    const overwatchDir = path.dirname(configPath);
    const hostDataDir = path.join(overwatchDir, 'data');
    if (fs.existsSync(hostDataDir)) return hostDataDir;
  } catch {}

  return dir;
}
