import * as fs from 'fs/promises';
import * as path from 'path';
import { getTenantsDir } from '../config';

const DATA_DIR = process.env.DATA_DIR || '/app/data';
const ENV_VARS_FILE = path.join(DATA_DIR, 'env-vars.json');
const TENANT_OVERRIDES_FILE = path.join(DATA_DIR, 'tenant-env-overrides.json');

const PROTECTED_KEYS = new Set([
  'NODE_ENV', 'PORT', 'FRONTEND_URL', 'BACKEND_URL',
  'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME',
  'JWT_SECRET', 'JWT_EXPIRES_IN', 'TENANT_ID', 'TENANT_DOMAIN',
  'IMAGE_TAG', 'GITHUB_REPO',
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
  source: 'global' | 'override';
}

async function ensureDataDir(): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (error) {
    // Directory might already exist
  }
}

async function readEnvVars(): Promise<EnvVar[]> {
  try {
    const data = await fs.readFile(ENV_VARS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      await saveEnvVars([]);
      return [];
    }
    throw error;
  }
}

async function saveEnvVars(vars: EnvVar[]): Promise<void> {
  await ensureDataDir();
  await fs.writeFile(ENV_VARS_FILE, JSON.stringify(vars, null, 2));
}

async function readTenantOverrides(): Promise<TenantEnvOverride[]> {
  try {
    const data = await fs.readFile(TENANT_OVERRIDES_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      await saveTenantOverrides([]);
      return [];
    }
    throw error;
  }
}

async function saveTenantOverrides(overrides: TenantEnvOverride[]): Promise<void> {
  await ensureDataDir();
  await fs.writeFile(TENANT_OVERRIDES_FILE, JSON.stringify(overrides, null, 2));
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

// Global env vars CRUD

export async function listEnvVars(): Promise<EnvVar[]> {
  return readEnvVars();
}

export async function setEnvVar(
  key: string,
  value: string,
  sensitive: boolean = false,
  description?: string
): Promise<EnvVar> {
  const validation = validateEnvVarKey(key);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const vars = await readEnvVars();
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

  await saveEnvVars(vars);
  return vars.find(v => v.key === key)!;
}

export async function deleteEnvVar(key: string): Promise<void> {
  const vars = await readEnvVars();
  const index = vars.findIndex(v => v.key === key);
  if (index === -1) {
    throw new Error(`Environment variable "${key}" not found`);
  }
  vars.splice(index, 1);
  await saveEnvVars(vars);
}

// Per-tenant overrides

export async function getTenantOverrides(tenantId: string): Promise<TenantEnvOverride['overrides']> {
  const allOverrides = await readTenantOverrides();
  const tenant = allOverrides.find(t => t.tenantId === tenantId);
  return tenant?.overrides || [];
}

export async function setTenantOverride(
  tenantId: string,
  key: string,
  value: string,
  sensitive: boolean = false
): Promise<void> {
  const validation = validateEnvVarKey(key);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const allOverrides = await readTenantOverrides();
  let tenant = allOverrides.find(t => t.tenantId === tenantId);

  if (!tenant) {
    tenant = { tenantId, overrides: [] };
    allOverrides.push(tenant);
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

  await saveTenantOverrides(allOverrides);
}

export async function deleteTenantOverride(tenantId: string, key: string): Promise<void> {
  const allOverrides = await readTenantOverrides();
  const tenant = allOverrides.find(t => t.tenantId === tenantId);

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
    const tenantIndex = allOverrides.indexOf(tenant);
    allOverrides.splice(tenantIndex, 1);
  }

  await saveTenantOverrides(allOverrides);
}

export async function deleteTenantAllOverrides(tenantId: string): Promise<void> {
  const allOverrides = await readTenantOverrides();
  const index = allOverrides.findIndex(t => t.tenantId === tenantId);

  if (index !== -1) {
    allOverrides.splice(index, 1);
    await saveTenantOverrides(allOverrides);
  }
}

// Merged view

export async function getEffectiveEnvVars(tenantId: string): Promise<EffectiveEnvVar[]> {
  const globalVars = await readEnvVars();
  const tenantOverrides = await getTenantOverrides(tenantId);

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

  // Add overrides for keys not in global (orphaned overrides)
  for (const ov of tenantOverrides) {
    if (!globalVars.find(gv => gv.key === ov.key)) {
      effective.push({
        key: ov.key,
        value: ov.value,
        sensitive: ov.sensitive,
        source: 'override',
      });
    }
  }

  return effective;
}

// File generation

export async function generateSharedEnvFile(tenantId: string): Promise<void> {
  const tenantsDir = getTenantsDir();
  const tenantPath = path.join(tenantsDir, tenantId);

  // Check tenant directory exists
  try {
    await fs.access(tenantPath);
  } catch {
    return; // Skip if tenant directory doesn't exist
  }

  const effective = await getEffectiveEnvVars(tenantId);

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
  const tenantsDir = getTenantsDir();
  let count = 0;

  try {
    const entries = await fs.readdir(tenantsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Verify it's actually a tenant directory (has .env file)
        try {
          await fs.access(path.join(tenantsDir, entry.name, '.env'));
          await generateSharedEnvFile(entry.name);
          count++;
        } catch {
          // Not a tenant directory, skip
        }
      }
    }
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      // Tenants directory doesn't exist yet
      return 0;
    }
    throw error;
  }

  return count;
}
