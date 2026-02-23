import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { findConfigPath } from '../config/loader';
import { LegacyOverwatchConfigSchema, LegacyOverwatchConfig, OverwatchConfig } from '../config/schema';
import { AppDefinition } from '../models/app';
import { generateComposeFile } from './composeGenerator';

const MIGRATION_MARKER = '.migration-v2-complete';

/**
 * Check if the current config is in legacy format (has registry + services keys)
 * and migration hasn't already been performed.
 */
export function isLegacyFormat(): boolean {
  try {
    const configPath = findConfigPath();
    const raw = yaml.load(fsSync.readFileSync(configPath, 'utf-8')) as any;
    if (!(raw?.registry && raw?.services)) return false;

    // Even if yaml still has legacy keys (read-only mount), skip if already migrated
    const dataDir = raw?.data_dir || '/app/data';
    if (isMigrationComplete(dataDir)) return false;

    return true;
  } catch {
    return false;
  }
}

/**
 * Check if migration has already been performed
 */
export function isMigrationComplete(dataDir: string): boolean {
  return fsSync.existsSync(path.join(dataDir, MIGRATION_MARKER));
}

/**
 * Run the migration from single-app to multi-app format.
 * - Creates a default app from old config
 * - Moves tenants/{id}/ to apps/{defaultApp}/tenants/{id}/
 * - Updates tenant .env files with APP_ID
 * - Restructures env-vars.json and tenant-env-overrides.json
 * - Regenerates compose files with new container names
 * - Slims down overwatch.yaml
 */
export async function runMigration(): Promise<void> {
  console.log('[Migration] Detecting legacy configuration...');

  const configPath = findConfigPath();
  const rawYaml = yaml.load(fsSync.readFileSync(configPath, 'utf-8')) as any;

  // Parse with legacy schema
  const parseResult = LegacyOverwatchConfigSchema.safeParse(rawYaml);
  if (!parseResult.success) {
    throw new Error(`Cannot parse legacy config: ${parseResult.error.message}`);
  }

  const legacyConfig = parseResult.data;
  const dataDir = legacyConfig.data_dir || '/app/data';
  const tenantsDir = legacyConfig.networking?.tenants_path || '/app/tenants';

  // Check migration marker
  if (isMigrationComplete(dataDir)) {
    console.log('[Migration] Already migrated. Skipping.');
    return;
  }

  console.log('[Migration] Starting migration to multi-app format...');

  // 1. Create default app from legacy config
  const appId = legacyConfig.project.prefix || 'default';
  const defaultApp: AppDefinition = {
    id: appId,
    name: legacyConfig.project.name,
    domain_template: '*.' + appId + '.com', // Placeholder
    registry: {
      type: legacyConfig.registry.type,
      url: legacyConfig.registry.url,
      repository: legacyConfig.registry.repository,
      auth: {
        type: legacyConfig.registry.auth.type,
        username_env: legacyConfig.registry.auth.username_env,
        token_env: legacyConfig.registry.auth.token_env,
        aws_region_env: legacyConfig.registry.auth.aws_region_env,
      },
      tag_pattern: legacyConfig.registry.tag_pattern,
    },
    services: legacyConfig.services.map(s => ({
      name: s.name,
      required: s.required ?? false,
      is_init_container: s.is_init_container ?? false,
      image_suffix: s.image_suffix,
      ports: s.ports,
      health_check: s.health_check,
      backup: s.backup ? {
        enabled: s.backup.enabled ?? false,
        paths: s.backup.paths,
      } : undefined,
      command: s.command,
      env_mapping: s.env_mapping,
    })),
    backup: legacyConfig.backup ? {
      enabled: legacyConfig.backup.enabled ?? false,
      schedule: legacyConfig.backup.schedule,
      provider: legacyConfig.backup.provider,
      s3: legacyConfig.backup.s3 ? {
        endpoint_env: legacyConfig.backup.s3.endpoint_env,
        bucket_env: legacyConfig.backup.s3.bucket_env,
        access_key_env: legacyConfig.backup.s3.access_key_env,
        secret_key_env: legacyConfig.backup.s3.secret_key_env,
      } : undefined,
      restic_password_env: legacyConfig.backup.restic_password_env,
    } : undefined,
    admin_access: legacyConfig.admin_access ? {
      enabled: legacyConfig.admin_access.enabled ?? false,
      url_template: legacyConfig.admin_access.url_template,
      secret_env: legacyConfig.admin_access.secret_env,
      token_payload: legacyConfig.admin_access.token_payload,
    } : undefined,
    credentials: legacyConfig.credentials,
    default_image_tag: 'latest',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Try to detect domain template from existing tenants
  try {
    const tenantDirs = await fs.readdir(tenantsDir, { withFileTypes: true });
    for (const entry of tenantDirs) {
      if (entry.isDirectory()) {
        try {
          const envContent = await fs.readFile(path.join(tenantsDir, entry.name, '.env'), 'utf-8');
          const domainMatch = envContent.match(/^TENANT_DOMAIN=(.+)$/m);
          if (domainMatch) {
            const domain = domainMatch[1];
            // Extract base domain from tenant domain
            const parts = domain.split('.');
            if (parts.length >= 2) {
              const baseDomain = parts.slice(-2).join('.');
              defaultApp.domain_template = `*.${baseDomain}`;
              break;
            }
          }
        } catch {
          // Skip
        }
      }
    }
  } catch {
    // No tenants dir
  }

  // 2. Write apps.json
  const appsFile = path.join(dataDir, 'apps.json');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(appsFile, JSON.stringify([defaultApp], null, 2));
  console.log(`[Migration] Created app '${appId}' in apps.json`);

  // 3. Move tenants to apps/{appId}/tenants/ and regenerate compose files
  const appsDir = legacyConfig.networking?.tenants_path
    ? path.resolve(path.dirname(legacyConfig.networking.tenants_path), 'apps')
    : '/app/apps';
  const newTenantsDir = path.join(appsDir, appId, 'tenants');
  await fs.mkdir(newTenantsDir, { recursive: true });

  // Build a minimal OverwatchConfig for compose file generation
  const minimalConfig = {
    project: legacyConfig.project,
    database: legacyConfig.database,
    networking: {
      external_network: legacyConfig.networking?.external_network || `${legacyConfig.project.prefix}-network`,
    },
  } as OverwatchConfig;

  try {
    const tenantDirs = await fs.readdir(tenantsDir, { withFileTypes: true });
    for (const entry of tenantDirs) {
      if (!entry.isDirectory()) continue;
      const tenantId = entry.name;
      const oldPath = path.join(tenantsDir, tenantId);
      const newPath = path.join(newTenantsDir, tenantId);

      // Copy tenant directory
      await fs.cp(oldPath, newPath, { recursive: true });

      // Update .env with APP_ID
      const envPath = path.join(newPath, '.env');
      try {
        let envContent = await fs.readFile(envPath, 'utf-8');
        if (!envContent.includes('APP_ID=')) {
          envContent = envContent.replace(
            /^(# Tenant Identification)/m,
            `# App Identification\nAPP_ID=${appId}\n\n$1`
          );
          // If the header wasn't found, just prepend it
          if (!envContent.includes('APP_ID=')) {
            envContent = `APP_ID=${appId}\n${envContent}`;
          }
        }

        await fs.writeFile(envPath, envContent);

        // Regenerate docker-compose.yml with new container naming
        const domainMatch = envContent.match(/^TENANT_DOMAIN=(.+)$/m);
        const domain = domainMatch ? domainMatch[1] : '';
        if (domain) {
          const composeContent = generateComposeFile({
            app: defaultApp,
            tenantId,
            domain,
            config: minimalConfig,
          });
          await fs.writeFile(path.join(newPath, 'docker-compose.yml'), composeContent);
        }
      } catch {
        // Skip env update if file doesn't exist
      }

      console.log(`[Migration] Moved tenant '${tenantId}' to apps/${appId}/tenants/`);
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      console.error('[Migration] Error moving tenants:', err.message);
    }
  }

  // 4. Restructure env-vars.json: array -> { appId: array }
  const envVarsFile = path.join(dataDir, 'env-vars.json');
  try {
    const content = await fs.readFile(envVarsFile, 'utf-8');
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      const newFormat: Record<string, any[]> = { [appId]: parsed };
      await fs.writeFile(envVarsFile, JSON.stringify(newFormat, null, 2));
      console.log('[Migration] Restructured env-vars.json');
    }
  } catch {
    // File doesn't exist or is already new format
  }

  // 5. Restructure tenant-env-overrides.json: array -> { appId: array }
  const overridesFile = path.join(dataDir, 'tenant-env-overrides.json');
  try {
    const content = await fs.readFile(overridesFile, 'utf-8');
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      const newFormat: Record<string, any[]> = { [appId]: parsed };
      await fs.writeFile(overridesFile, JSON.stringify(newFormat, null, 2));
      console.log('[Migration] Restructured tenant-env-overrides.json');
    }
  } catch {
    // File doesn't exist or is already new format
  }

  // 6. Slim down overwatch.yaml (may fail if config is read-only)
  const slimConfig: any = {
    project: rawYaml.project,
    database: rawYaml.database,
  };
  if (rawYaml.credentials) slimConfig.credentials = rawYaml.credentials;
  if (rawYaml.monitoring) slimConfig.monitoring = rawYaml.monitoring;
  if (rawYaml.alert_rules) slimConfig.alert_rules = rawYaml.alert_rules;
  if (rawYaml.data_dir) slimConfig.data_dir = rawYaml.data_dir;

  // Update networking to use apps_path instead of tenants_path
  slimConfig.networking = {
    external_network: rawYaml.networking?.external_network || `${legacyConfig.project.prefix}-network`,
    apps_path: appsDir,
  };

  try {
    // Backup the old config
    const backupPath = configPath + '.pre-migration';
    await fs.copyFile(configPath, backupPath);
    console.log(`[Migration] Backed up old config to ${backupPath}`);

    // Write slimmed config
    await fs.writeFile(configPath, yaml.dump(slimConfig, { lineWidth: -1 }));
    console.log('[Migration] Updated overwatch.yaml (removed registry, services, backup, admin_access)');
  } catch (err: any) {
    console.warn(`[Migration] Could not update overwatch.yaml (${err.code || err.message}).`);
    console.warn('[Migration] The config file may be read-only. Update it manually to the slim format:');
    console.warn(yaml.dump(slimConfig, { lineWidth: -1 }));
  }

  // 7. Write migration marker (always, even if config write failed)
  await fs.writeFile(path.join(dataDir, MIGRATION_MARKER), new Date().toISOString());
  console.log('[Migration] Migration complete!');
  console.log(`[Migration] Created app '${appId}' with ${defaultApp.services.length} services`);
}
