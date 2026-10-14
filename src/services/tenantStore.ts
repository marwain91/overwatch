import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { getAppsDir } from '../config';
import { parseEnv, unquoteEnvValue } from '../utils/env';
import { assertWithinDir } from '../utils/security';
import { ValidationError } from '../utils/httpErrors';

/**
 * The one place that knows the on-disk tenant layout:
 *   <appsDir>/<appId>/tenants/<tenantId>/
 */

function assertSegment(kind: 'app' | 'tenant', id: string): void {
  if (typeof id !== 'string' || id === '' || id === '.' || id === '..' || /[\\/\0]/.test(id)) {
    throw new ValidationError(`Invalid ${kind} id: ${JSON.stringify(id)}`);
  }
}

/** `<appsDir>/<appId>/tenants`. Throws for an app id that is not a single path segment. */
export function tenantsDir(appId: string): string {
  assertSegment('app', appId);
  return path.join(getAppsDir(), appId, 'tenants');
}

/**
 * Directory of one tenant. Ids that are not a single path segment (`..`,
 * absolute paths, separators) are rejected, so the result is always inside
 * the apps dir. Purely lexical, so it works before the directory exists;
 * use `assertTenantDir` once it does to also rule out symlink escapes.
 */
export function tenantDir(appId: string, tenantId: string): string {
  assertSegment('tenant', tenantId);
  return path.join(tenantsDir(appId), tenantId);
}

/** `tenantDir` for a directory that exists, verified (via realpath) to stay inside the apps dir. */
export async function assertTenantDir(appId: string, tenantId: string): Promise<string> {
  const dir = tenantDir(appId, tenantId);
  await assertWithinDir(dir, getAppsDir());
  return dir;
}

export interface TenantRef {
  appId: string;
  tenantId: string;
  dir: string;
}

export interface ListTenantDirsOptions {
  /**
   * Called for a per-app listing failure other than "absent" (e.g. EACCES);
   * the app is then skipped. Without it such failures are thrown.
   */
  onError?: (appId: string, err: unknown) => void;
}

const ABSENT = new Set(['ENOENT', 'ENOTDIR']);

async function subdirs(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) out.push(e.name);
    else if (e.isSymbolicLink()) {
      // A symlinked tenant dir counts; callers that need containment use assertTenantDir.
      try { if ((await fs.stat(path.join(dir, e.name))).isDirectory()) out.push(e.name); } catch { /* dangling */ }
    }
  }
  return out;
}

/**
 * Tenant directories (not files, not dot entries) of one app, or of every app
 * directory under the apps dir. A missing apps dir or tenants dir is empty.
 * An unreadable apps dir throws.
 */
export async function listTenantDirs(appId?: string, opts: ListTenantDirsOptions = {}): Promise<TenantRef[]> {
  let appIds: string[];
  if (appId !== undefined) {
    appIds = [appId];
  } else {
    try {
      appIds = await subdirs(getAppsDir());
    } catch (err: any) {
      if (ABSENT.has(err?.code)) return [];
      throw err;
    }
  }

  const out: TenantRef[] = [];
  for (const id of appIds) {
    let tenantIds: string[];
    try {
      tenantIds = await subdirs(tenantsDir(id));
    } catch (err: any) {
      if (ABSENT.has(err?.code)) continue;
      if (opts.onError) { opts.onError(id, err); continue; }
      throw err;
    }
    for (const tenantId of tenantIds) out.push({ appId: id, tenantId, dir: path.join(tenantsDir(id), tenantId) });
  }
  return out;
}

/**
 * Synchronous walk of an explicit apps dir, for the CLI's config checks, which
 * run outside the server. Same filtering as `listTenantDirs`; unreadable
 * directories are treated as empty.
 */
export function listTenantDirsSync(appsDir: string): TenantRef[] {
  const dirs = (dir: string): string[] => {
    try {
      return fsSync.readdirSync(dir, { withFileTypes: true })
        .filter(e => {
          if (e.name.startsWith('.')) return false;
          if (e.isDirectory()) return true;
          try { return e.isSymbolicLink() && fsSync.statSync(path.join(dir, e.name)).isDirectory(); } catch { return false; }
        })
        .map(e => e.name);
    } catch {
      return [];
    }
  };
  const out: TenantRef[] = [];
  for (const appId of dirs(appsDir)) {
    const base = path.join(appsDir, appId, 'tenants');
    for (const tenantId of dirs(base)) out.push({ appId, tenantId, dir: path.join(base, tenantId) });
  }
  return out;
}

/** Parse tenant `.env` text into raw values (quotes written by `formatEnvValue` removed). */
export function parseTenantEnv(content: string): Record<string, string> {
  const env = parseEnv(content);
  for (const key of Object.keys(env)) env[key] = unquoteEnvValue(env[key]);
  return env;
}

/** Raw values of a tenant's `.env`. Rejects (ENOENT) when the tenant has none. */
export async function readTenantEnv(appId: string, tenantId: string): Promise<Record<string, string>> {
  return parseTenantEnv(await fs.readFile(path.join(tenantDir(appId, tenantId), '.env'), 'utf-8'));
}
