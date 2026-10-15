import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { isDeepStrictEqual } from 'util';
import * as yaml from 'js-yaml';
import { findConfigPath } from '../config/loader';
import { writeOverwatchConfig } from '../config/writer';
import { LegacyOverwatchConfigSchema, OverwatchConfig } from '../config/schema';
import { AppDefinition, AppDefinitionStaticSchema } from '../models/app';
import { generateComposeFile } from './composeGenerator';
import { formatEnvLine } from './envVars';
import { CURRENT_SCHEMA_VERSIONS, SchemaVersions, readSchemaVersions, writeSchemaVersions, findPendingMigrations } from './schemaVersions';
import { writeJsonAtomic } from '../utils/atomicJson';
import { writeSecretFile } from '../utils/security';
import { parseEnv, unquoteEnvValue } from '../utils/env';

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

    // Second safety guard: if apps.json already has entries, this is NOT a legacy
    // install regardless of what the yaml looks like. Prevents the migration from
    // stomping a populated multi-app apps.json when the marker file is missing
    // (e.g. data_dir changed, volume swap, or marker was never written).
    if (hasPopulatedAppsFile(dataDir)) return false;

    return true;
  } catch {
    return false;
  }
}

function hasPopulatedAppsFile(dataDir: string): boolean {
  try {
    const content = fsSync.readFileSync(path.join(dataDir, 'apps.json'), 'utf-8');
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) && parsed.length > 0;
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

/** TENANT_DOMAIN as compose reads it (quotes removed), or '' when absent. */
function tenantDomainFromEnv(envContent: string): string {
  const raw = parseEnv(envContent).TENANT_DOMAIN;
  return raw ? unquoteEnvValue(raw) : '';
}

/**
 * Copy one legacy tenant to its multi-app location, add APP_ID and
 * COMPOSE_PROJECT_NAME to its .env and regenerate its compose file. Only a
 * missing .env is skipped; any other failure is thrown to the caller.
 */
async function migrateLegacyTenant(opts: {
  appId: string;
  tenantId: string;
  oldPath: string;
  newPath: string;
  app: AppDefinition;
  config: OverwatchConfig;
}): Promise<void> {
  const { appId, tenantId, oldPath, newPath } = opts;
  await fs.cp(oldPath, newPath, { recursive: true });

  const envPath = path.join(newPath, '.env');
  let envContent: string;
  try {
    envContent = await fs.readFile(envPath, 'utf-8');
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
    console.warn(`[Migration] Tenant '${tenantId}' has no .env; copied without updating it`);
    return;
  }

  const keys = parseEnv(envContent);
  if (!('APP_ID' in keys)) {
    const appIdLine = formatEnvLine('APP_ID', appId);
    const withHeader = envContent.replace(/^(# Tenant Identification)/m, header => `# App Identification\n${appIdLine}\n\n${header}`);
    envContent = withHeader !== envContent ? withHeader : `${appIdLine}\n${envContent}`;
  }
  if (!('COMPOSE_PROJECT_NAME' in keys)) {
    envContent = `${formatEnvLine('COMPOSE_PROJECT_NAME', `${appId}-${tenantId}`)}\n${envContent}`;
  }

  // Tenant .env holds the DB password: 0600 + atomic, as tenant.ts writes it.
  await writeSecretFile(envPath, envContent);

  // Regenerate docker-compose.yml with new container naming. The copied file
  // is passed in so the tenant keeps the volume names that hold its data.
  const domain = tenantDomainFromEnv(envContent);
  if (domain) {
    const composePath = path.join(newPath, 'docker-compose.yml');
    const existingCompose = await fs.readFile(composePath, 'utf-8').catch((err: any) => {
      if (err?.code === 'ENOENT') return undefined;
      throw err;
    });
    const composeContent = generateComposeFile({ app: opts.app, tenantId, domain, config: opts.config, existingCompose });
    await fs.writeFile(composePath, composeContent);
  }
}

/** Convert a legacy array store (env-vars.json, tenant-env-overrides.json) to `{ appId: array }`. */
async function restructureLegacyStore(file: string, appId: string): Promise<boolean> {
  let content: string;
  try {
    content = await fs.readFile(file, 'utf-8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err: any) {
    throw new Error(`[Migration] ${path.basename(file)} is not valid JSON (${err.message}); fix or restore it and run the migration again`);
  }
  if (!Array.isArray(parsed)) return false;
  await writeJsonAtomic(file, { [appId]: parsed }, { mode: 0o600 });
  return true;
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
      health_check: s.health_check ? { ...s.health_check, tool: 'wget' as const } : undefined,
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
          const domain = tenantDomainFromEnv(envContent);
          if (domain) {
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

  // 2. Refuse to overwrite a populated apps.json. The marker file is the primary
  // guard, but defence-in-depth protects users whose marker vanished (volume
  // swap, data_dir change, manual deletion). apps.json itself is written only
  // after every tenant has moved: until then, a failed run stays "legacy" and
  // can simply be run again.
  const appsFile = path.join(dataDir, 'apps.json');
  await fs.mkdir(dataDir, { recursive: true });
  try {
    const existingRaw = await fs.readFile(appsFile, 'utf-8');
    const existing = JSON.parse(existingRaw);
    if (Array.isArray(existing) && existing.length > 0) {
      throw new Error(
        `Refusing to overwrite ${appsFile}: file already contains ${existing.length} app(s). ` +
        `This host is not a legacy install. Write marker manually: ` +
        `touch ${path.join(dataDir, MIGRATION_MARKER)}`
      );
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
  }

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

  let tenantEntries: fsSync.Dirent[] = [];
  try {
    tenantEntries = await fs.readdir(tenantsDir, { withFileTypes: true });
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw new Error(`[Migration] Cannot read ${tenantsDir}: ${err.message}`);
  }
  for (const entry of tenantEntries) {
    if (!entry.isDirectory()) continue;
    const tenantId = entry.name;
    try {
      await migrateLegacyTenant({
        appId,
        tenantId,
        oldPath: path.join(tenantsDir, tenantId),
        newPath: path.join(newTenantsDir, tenantId),
        app: defaultApp,
        config: minimalConfig,
      });
    } catch (err: any) {
      throw new Error(
        `[Migration] Tenant '${tenantId}' could not be moved: ${err?.message || err}. ` +
        `The migration is not marked complete; fix the cause and run it again.`,
      );
    }
    console.log(`[Migration] Moved tenant '${tenantId}' to apps/${appId}/tenants/`);
  }

  // 4. Restructure env-vars.json: array -> { appId: array }
  if (await restructureLegacyStore(path.join(dataDir, 'env-vars.json'), appId)) {
    console.log('[Migration] Restructured env-vars.json');
  }

  // 5. Restructure tenant-env-overrides.json: array -> { appId: array }
  if (await restructureLegacyStore(path.join(dataDir, 'tenant-env-overrides.json'), appId)) {
    console.log('[Migration] Restructured tenant-env-overrides.json');
  }

  // 6. Write apps.json now that everything it refers to is in place.
  await writeJsonAtomic(appsFile, [defaultApp], { mode: 0o644 });
  console.log(`[Migration] Created app '${appId}' in apps.json`);

  // 7. Slim down overwatch.yaml (may fail if config is read-only)
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
    await writeOverwatchConfig(slimConfig);
    console.log('[Migration] Updated overwatch.yaml (removed registry, services, backup, admin_access)');
  } catch (err: any) {
    console.warn(`[Migration] Could not update overwatch.yaml (${err.code || err.message}).`);
    console.warn('[Migration] The config file may be read-only. Update it manually to the slim format:');
    console.warn(yaml.dump(slimConfig, { lineWidth: -1 }));
  }

  // 8. Write the migration marker: every step above succeeded (a read-only
  // overwatch.yaml is only a warning; the data is fully migrated).
  await fs.writeFile(path.join(dataDir, MIGRATION_MARKER), new Date().toISOString());
  console.log('[Migration] Migration complete!');
  console.log(`[Migration] Created app '${appId}' with ${defaultApp.services.length} services`);
}

async function jsonFileNames(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter(e => e.endsWith('.json')).sort();
  } catch (err: any) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch (err: any) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

interface LegacyAppEntry {
  id: string;
  staticDef: Record<string, unknown>;
  runtime: { createdAt: string; updatedAt: string };
}

/** Every apps.json entry must load once split (same schema readApps uses), with unique ids. */
function validateLegacyApps(legacyApps: unknown[]): LegacyAppEntry[] {
  const problems: string[] = [];
  const entries: LegacyAppEntry[] = [];
  const seen = new Set<string>();
  const now = new Date().toISOString();
  legacyApps.forEach((app: any, i) => {
    if (!app || typeof app !== 'object' || typeof app.id !== 'string') {
      problems.push(`entry #${i + 1} has no string 'id' field: ${String(JSON.stringify(app)).slice(0, 120)}`);
      return;
    }
    const { createdAt, updatedAt, ...staticDef } = app;
    const parsed = AppDefinitionStaticSchema.safeParse(staticDef);
    if (!parsed.success) {
      problems.push(`app '${app.id}': ${parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`);
      return;
    }
    if (seen.has(app.id)) {
      problems.push(`duplicate id '${app.id}' (entry #${i + 1})`);
      return;
    }
    seen.add(app.id);
    // Preserve any timestamp present; synthesize from 'now' if missing so we
    // don't fail validation later. The migration runs once; this is the best
    // historical record we can offer for entries that lacked timestamps.
    entries.push({
      id: app.id,
      staticDef,
      runtime: {
        createdAt: typeof createdAt === 'string' ? createdAt : now,
        updatedAt: typeof updatedAt === 'string' ? updatedAt : now,
      },
    });
  });
  if (problems.length > 0) {
    throw new Error(
      `apps v2→v3 migration: apps.json has entries that cannot be migrated; nothing was written. ` +
      `Fix apps.json and run the migration again:\n  - ${problems.join('\n  - ')}`,
    );
  }
  return entries;
}

/**
 * apps.d/ files present while apps.json still exists come from an earlier run
 * that did not finish. Redoing the split is only safe when each of them is
 * exactly what apps.json would produce; anything else was edited since.
 */
async function assertNoDivergedAppFiles(appsDDir: string, entries: LegacyAppEntry[]): Promise<void> {
  const expected = new Map(entries.map(e => [`${e.id}.json`, e.staticDef]));
  const conflicts: string[] = [];
  for (const file of await jsonFileNames(appsDDir)) {
    const want = expected.get(file);
    if (!want) {
      conflicts.push(`apps.d/${file} is not in apps.json`);
      continue;
    }
    let have: unknown;
    try {
      have = JSON.parse(await fs.readFile(path.join(appsDDir, file), 'utf-8'));
    } catch {
      have = undefined;
    }
    if (!isDeepStrictEqual(have, want)) conflicts.push(`apps.d/${file} differs from its apps.json entry`);
  }
  if (conflicts.length > 0) {
    throw new Error(
      `apps v2→v3 migration: apps.json is still present, but apps.d/ already holds app files that a re-run ` +
      `would overwrite. Nothing was changed:\n  - ${conflicts.join('\n  - ')}\n` +
      `Compare apps.json with apps.d/. If apps.d/ is current, move apps.json aside (for example to ` +
      `apps.json.pre-apps.d); otherwise move the differing files out of apps.d/. Then run 'overwatch migrate up' again.`,
    );
  }
}

/** apps.json still on disk: the v2→v3 split has not completed. */
export async function hasUnsplitAppsFile(): Promise<boolean> {
  const { getDataDir } = await import('../config');
  return pathExists(path.join(getDataDir(), 'apps.json'));
}

/**
 * Migrate apps schema v2 → v3: split the single data/apps.json array into
 * per-app static files in data/apps.d/ plus a data/apps.runtime.json sidecar.
 *
 * apps.json is renamed away as the very last step, so its presence alone says
 * whether the split still has to happen; a run that stopped part-way can be
 * run again. Every entry is checked before anything is written, the new
 * apps.d/ and runtime file are built in a staging dir and renamed into place.
 */
export async function runAppsV3Migration(): Promise<void> {
  const { getDataDir } = await import('../config');
  const dataDir = getDataDir();
  const legacyPath = path.join(dataDir, 'apps.json');
  const appsDDir = path.join(dataDir, 'apps.d');
  const runtimePath = path.join(dataDir, 'apps.runtime.json');

  let legacyRaw: string;
  try {
    legacyRaw = await fs.readFile(legacyPath, 'utf-8');
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
    // Already split (apps.json renamed away) or a fresh install: make sure the
    // v3 layout exists, never touching what is there.
    await fs.mkdir(appsDDir, { recursive: true });
    if (!(await pathExists(runtimePath))) await fs.writeFile(runtimePath, '{}\n', { mode: 0o644 });
    console.log('[migrate] apps v2→v3: no apps.json to split — nothing to do');
    return;
  }

  let legacyApps: unknown;
  try {
    legacyApps = JSON.parse(legacyRaw);
  } catch (err: any) {
    throw new Error(`apps v2→v3 migration: apps.json is not valid JSON (${err.message}). Fix or restore before running.`);
  }
  if (!Array.isArray(legacyApps)) {
    throw new Error(`apps v2→v3 migration: apps.json must be an array; got ${typeof legacyApps}.`);
  }
  const entries = validateLegacyApps(legacyApps);
  await assertNoDivergedAppFiles(appsDDir, entries);

  const staging = path.join(dataDir, `.apps-v3-${randomUUID()}`);
  const stagedAppsD = path.join(staging, 'apps.d');
  const stagedRuntime = path.join(staging, 'apps.runtime.json');
  const replaced = path.join(staging, 'replaced-apps.d');
  await fs.mkdir(stagedAppsD, { recursive: true });
  let movedAside = false;
  try {
    const runtimeStore: Record<string, { createdAt: string; updatedAt: string }> = {};
    for (const entry of entries) {
      runtimeStore[entry.id] = entry.runtime;
      await writeJsonAtomic(path.join(stagedAppsD, `${entry.id}.json`), entry.staticDef, { mode: 0o644 });
    }
    await writeJsonAtomic(stagedRuntime, runtimeStore, { mode: 0o644 });

    // Any existing apps.d/ only holds files identical to the staged ones (checked above).
    if (await pathExists(appsDDir)) {
      await fs.rename(appsDDir, replaced);
      movedAside = true;
    }
    await fs.rename(stagedAppsD, appsDDir);
    movedAside = false;
    await fs.rename(stagedRuntime, runtimePath);

    // Last: with apps.json gone the split counts as done. Never overwrite an older backup.
    let backupPath = path.join(dataDir, 'apps.json.pre-apps.d');
    if (await pathExists(backupPath)) backupPath += `.${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await fs.rename(legacyPath, backupPath);
    console.log(`[migrate] apps v2→v3: split ${entries.length} app(s) into apps.d/; legacy backup at ${backupPath}`);
  } catch (err) {
    if (movedAside && !(await pathExists(appsDDir))) await fs.rename(replaced, appsDDir).catch(() => {});
    throw err;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

/**
 * Run every pending data migration: the legacy single-app conversion, then
 * the schema-version steps (apps v2→v3 split). The versions file is written
 * only after all of them succeeded, so a failed run stays pending. Used by
 * `overwatch migrate up` and by the server under OVERWATCH_AUTO_MIGRATE=1.
 */
export async function runPendingMigrations(log: (msg: string) => void = msg => console.log(`[migrate] ${msg}`)): Promise<{
  legacy: boolean;
  pending: Array<{ store: keyof SchemaVersions; from: number; to: number }>;
  initialised: boolean;
}> {
  let legacy = false;
  if (isLegacyFormat()) {
    log('legacy → multi-app migration running...');
    await runMigration();
    legacy = true;
  }

  const stored = await readSchemaVersions();
  const pending = findPendingMigrations(stored);
  const initialised = Object.keys(stored).length === 0;
  for (const { store, from, to } of pending) {
    if (store === 'apps' && from < 3 && to >= 3) {
      log(`apps: v${from} → v${to} running...`);
      await runAppsV3Migration();
    } else {
      log(`${store}: v${from} → v${to} (no transform required)`);
    }
  }
  // No versions file yet (first run, or straight from a legacy install): an
  // apps.json still on disk is split before the file records apps v3.
  if (initialised && (await hasUnsplitAppsFile())) {
    log('apps: apps.json → apps.d/ running...');
    await runAppsV3Migration();
  }

  if (pending.length > 0 || initialised) await writeSchemaVersions(CURRENT_SCHEMA_VERSIONS);
  return { legacy, pending, initialised };
}
