import * as fs from 'fs/promises';
import * as path from 'path';
import { getAppsDir, getDataDir } from '../config';
import { withFileLock } from './fileLock';
import { assertWithinDir } from '../utils/security';

function getEnvVarsFile(): string {
  return path.join(getDataDir(), 'env-vars.json');
}

function getTenantOverridesFile(): string {
  return path.join(getDataDir(), 'tenant-env-overrides.json');
}

const PROTECTED_KEYS = new Set([
  'NODE_ENV', 'PORT', 'FRONTEND_URL', 'BACKEND_URL',
  'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME',
  'JWT_SECRET', 'JWT_EXPIRES_IN', 'TENANT_ID', 'TENANT_DOMAIN',
  'IMAGE_REGISTRY', 'IMAGE_TAG', 'PROJECT_PREFIX', 'SHARED_NETWORK',
  'APP_ID', 'CERT_RESOLVER',
  // Node.js / system vars that could alter runtime behavior
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'PATH', 'HOME', 'SHELL',
]);

export interface EnvVar {
  key: string;
  value: string;
  sensitive: boolean;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TenantEnvOverride {
  tenantId: string;
  overrides: Array<{ key: string; value: string; sensitive: boolean; updatedAt: string }>;
}

export interface EffectiveEnvVar {
  key: string;
  value: string;
  sensitive: boolean;
  description?: string;
  source: 'global' | 'override' | 'tenant-only';
}

// ─── Storage format: keyed by appId ─────────────────────────────────────────

// env-vars.json: { "myapp": [...vars], "cms": [...vars] }
type EnvVarsStore = Record<string, EnvVar[]>;

// tenant-env-overrides.json: { "myapp": [{ tenantId, overrides }], ... }
type TenantOverridesStore = Record<string, TenantEnvOverride[]>;

async function ensureDataDir(): Promise<void> {
  try {
    await fs.mkdir(getDataDir(), { recursive: true });
  } catch (error) {
    // Directory might already exist
  }
}

async function readEnvVarsStore(): Promise<EnvVarsStore> {
  try {
    const data = await fs.readFile(getEnvVarsFile(), 'utf-8');
    const parsed = JSON.parse(data);
    // Handle legacy format (flat array) — treat as no apps
    if (Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      await saveEnvVarsStore({});
      return {};
    }
    throw error;
  }
}

async function saveEnvVarsStore(store: EnvVarsStore): Promise<void> {
  await ensureDataDir();
  await fs.writeFile(getEnvVarsFile(), JSON.stringify(store, null, 2));
}

async function readTenantOverridesStore(): Promise<TenantOverridesStore> {
  try {
    const data = await fs.readFile(getTenantOverridesFile(), 'utf-8');
    const parsed = JSON.parse(data);
    // Handle legacy format (flat array)
    if (Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      await saveTenantOverridesStore({});
      return {};
    }
    throw error;
  }
}

async function saveTenantOverridesStore(store: TenantOverridesStore): Promise<void> {
  await ensureDataDir();
  await fs.writeFile(getTenantOverridesFile(), JSON.stringify(store, null, 2));
}

export function validateEnvVarKey(key: string): { valid: boolean; error?: string } {
  if (!key) {
    return { valid: false, error: 'Key is required' };
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    return { valid: false, error: 'Key must match format: starts with uppercase letter, followed by uppercase letters, digits, or underscores' };
  }
  if (PROTECTED_KEYS.has(key)) {
    return { valid: false, error: `Key "${key}" is a protected core variable and cannot be used` };
  }
  return { valid: true };
}

// ─── Global env vars CRUD (per app) ─────────────────────────────────────────

export async function listEnvVars(appId: string): Promise<EnvVar[]> {
  const store = await readEnvVarsStore();
  return store[appId] || [];
}

export async function setEnvVar(
  appId: string,
  key: string,
  value: string,
  sensitive: boolean = false,
  description?: string
): Promise<EnvVar> {
  const validation = validateEnvVarKey(key);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  return withFileLock('env-vars', async () => {
    const store = await readEnvVarsStore();
    if (!store[appId]) store[appId] = [];
    const vars = store[appId];
    const now = new Date().toISOString();
    const existing = vars.find(v => v.key === key);

    if (existing) {
      existing.value = value;
      existing.sensitive = sensitive;
      if (description !== undefined) {
        existing.description = description;
      }
      existing.updatedAt = now;
    } else {
      vars.push({
        key,
        value,
        sensitive,
        description,
        createdAt: now,
        updatedAt: now,
      });
    }

    await saveEnvVarsStore(store);
    return vars.find(v => v.key === key)!;
  });
}

export async function deleteEnvVar(appId: string, key: string): Promise<void> {
  return withFileLock('env-vars', async () => {
    const store = await readEnvVarsStore();
    const vars = store[appId] || [];
    const index = vars.findIndex(v => v.key === key);
    if (index === -1) {
      throw new Error(`Environment variable "${key}" not found`);
    }
    vars.splice(index, 1);
    store[appId] = vars;
    await saveEnvVarsStore(store);
  });
}

// ─── Per-tenant overrides ────────────────────────────────────────────────────

export async function getTenantOverrides(appId: string, tenantId: string): Promise<TenantEnvOverride['overrides']> {
  const store = await readTenantOverridesStore();
  const appOverrides = store[appId] || [];
  const tenant = appOverrides.find(t => t.tenantId === tenantId);
  return tenant?.overrides || [];
}

export async function setTenantOverride(
  appId: string,
  tenantId: string,
  key: string,
  value: string,
  sensitive: boolean = false
): Promise<void> {
  const validation = validateEnvVarKey(key);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  return withFileLock('tenant-overrides', async () => {
    const store = await readTenantOverridesStore();
    if (!store[appId]) store[appId] = [];
    const appOverrides = store[appId];
    let tenant = appOverrides.find(t => t.tenantId === tenantId);

    if (!tenant) {
      tenant = { tenantId, overrides: [] };
      appOverrides.push(tenant);
    }

    const now = new Date().toISOString();
    const existing = tenant.overrides.find(o => o.key === key);

    if (existing) {
      existing.value = value;
      existing.sensitive = sensitive;
      existing.updatedAt = now;
    } else {
      tenant.overrides.push({ key, value, sensitive, updatedAt: now });
    }

    await saveTenantOverridesStore(store);
  });
}

export async function deleteTenantOverride(appId: string, tenantId: string, key: string): Promise<void> {
  return withFileLock('tenant-overrides', async () => {
    const store = await readTenantOverridesStore();
    const appOverrides = store[appId] || [];
    const tenant = appOverrides.find(t => t.tenantId === tenantId);

    if (!tenant) {
      throw new Error(`No overrides found for tenant "${tenantId}"`);
    }

    const index = tenant.overrides.findIndex(o => o.key === key);
    if (index === -1) {
      throw new Error(`Override "${key}" not found for tenant "${tenantId}"`);
    }

    tenant.overrides.splice(index, 1);

    // Remove tenant entry if no overrides remain
    if (tenant.overrides.length === 0) {
      const tenantIndex = appOverrides.indexOf(tenant);
      appOverrides.splice(tenantIndex, 1);
    }

    await saveTenantOverridesStore(store);
  });
}

export async function deleteTenantAllOverrides(appId: string, tenantId: string): Promise<void> {
  return withFileLock('tenant-overrides', async () => {
    const store = await readTenantOverridesStore();
    const appOverrides = store[appId] || [];
    const index = appOverrides.findIndex(t => t.tenantId === tenantId);

    if (index !== -1) {
      appOverrides.splice(index, 1);
      await saveTenantOverridesStore(store);
    }
  });
}

// ─── Merged view ─────────────────────────────────────────────────────────────

export async function getEffectiveEnvVars(appId: string, tenantId: string): Promise<EffectiveEnvVar[]> {
  const globalVars = await listEnvVars(appId);
  const tenantOverrides = await getTenantOverrides(appId, tenantId);

  const effective: EffectiveEnvVar[] = [];

  for (const gv of globalVars) {
    const override = tenantOverrides.find(o => o.key === gv.key);
    if (override) {
      effective.push({
        key: gv.key,
        value: override.value,
        sensitive: override.sensitive,
        description: gv.description,
        source: 'override',
      });
    } else {
      effective.push({
        key: gv.key,
        value: gv.value,
        sensitive: gv.sensitive,
        description: gv.description,
        source: 'global',
      });
    }
  }

  // Add overrides for keys not in global (tenant-only vars)
  for (const ov of tenantOverrides) {
    if (!globalVars.find(gv => gv.key === ov.key)) {
      effective.push({
        key: ov.key,
        value: ov.value,
        sensitive: ov.sensitive,
        source: 'tenant-only',
      });
    }
  }

  return effective;
}

// ─── File generation ─────────────────────────────────────────────────────────

export async function generateSharedEnvFile(appId: string, tenantId: string): Promise<void> {
  const appsDir = getAppsDir();
  const tenantPath = path.join(appsDir, appId, 'tenants', tenantId);

  // Check tenant directory exists
  try {
    await fs.access(tenantPath);
  } catch {
    return; // Skip if tenant directory doesn't exist
  }

  // Verify path hasn't been manipulated via symlinks
  await assertWithinDir(tenantPath, appsDir);

  const effective = await getEffectiveEnvVars(appId, tenantId);

  const lines = [
    '# Shared environment variables',
    `# Generated by Overwatch: ${new Date().toISOString()}`,
    '# Do not edit manually - managed via Overwatch admin panel',
    '',
  ];

  for (const v of effective) {
    lines.push(`${v.key}=${v.value}`);
  }

  lines.push(''); // trailing newline

  const sharedEnvPath = path.join(tenantPath, 'shared.env');

  // If shared.env is a symlink, remove it first so we write a real file
  try {
    const stat = await fs.lstat(sharedEnvPath);
    if (stat.isSymbolicLink()) {
      await fs.unlink(sharedEnvPath);
    }
  } catch {
    // File doesn't exist yet, that's fine
  }

  await fs.writeFile(sharedEnvPath, lines.join('\n'));
}

export async function regenerateAllSharedEnvFiles(): Promise<number> {
  const appsDir = getAppsDir();
  let count = 0;

  try {
    const appDirs = await fs.readdir(appsDir, { withFileTypes: true });
    for (const appEntry of appDirs) {
      if (!appEntry.isDirectory()) continue;
      const appId = appEntry.name;
      const tenantsDir = path.join(appsDir, appId, 'tenants');

      try {
        const tenantDirs = await fs.readdir(tenantsDir, { withFileTypes: true });
        for (const tenantEntry of tenantDirs) {
          if (!tenantEntry.isDirectory()) continue;
          const tenantId = tenantEntry.name;

          // Verify it's actually a tenant directory (has .env file)
          try {
            await fs.access(path.join(tenantsDir, tenantId, '.env'));
            await generateSharedEnvFile(appId, tenantId);
            count++;
          } catch {
            // Not a tenant directory, skip
          }
        }
      } catch {
        // No tenants dir for this app
      }
    }
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      // Apps directory doesn't exist yet
      return 0;
    }
    throw error;
  }

  return count;
}
