import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { getAppsDir } from '../config';
import { TraefikTenantSchema, type TraefikTenant } from '../models/traefik';
import { withFileLock } from './fileLock';

/**
 * Per-tenant Traefik overrides — host aliases, middleware overrides,
 * cert resolver override, raw labels. Stored alongside the tenant's
 * frozen app definition so it survives tenant updates.
 *
 *   <appsDir>/<appId>/tenants/<tenantId>/traefik.yaml
 */
const TENANT_TRAEFIK_FILE = 'traefik.yaml';

function getTenantTraefikPath(appId: string, tenantId: string): string {
  return path.join(getAppsDir(), appId, 'tenants', tenantId, TENANT_TRAEFIK_FILE);
}

/**
 * Read the tenant's Traefik overrides. Returns undefined when the file
 * doesn't exist (the common case — most tenants don't override anything).
 */
export async function readTenantTraefik(
  appId: string,
  tenantId: string,
): Promise<TraefikTenant | undefined> {
  const file = getTenantTraefikPath(appId, tenantId);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
  const parsed = TraefikTenantSchema.safeParse(yaml.load(raw));
  if (!parsed.success) {
    const errors = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
    throw new Error(`Invalid tenant Traefik overrides at ${file}: ${errors}`);
  }
  return parsed.data;
}

/**
 * Write tenant Traefik overrides. Pass undefined / null to delete the file.
 *
 * Serialised per (appId, tenantId) via withFileLock so concurrent UI/API
 * writers can't interleave. Atomic via tmp+rename — the parent dir is the
 * tenant's own directory under the bind-mounted apps tree, so this works
 * (the single-file bind-mount problem only applies to overwatch.yaml).
 */
export async function writeTenantTraefik(
  appId: string,
  tenantId: string,
  overrides: TraefikTenant | undefined | null,
): Promise<void> {
  return withFileLock(`tenant-traefik-${appId}-${tenantId}`, async () => {
    const file = getTenantTraefikPath(appId, tenantId);
    if (!overrides || isEmpty(overrides)) {
      try { await fs.unlink(file); } catch (err: any) { if (err.code !== 'ENOENT') throw err; }
      return;
    }
    const validated = TraefikTenantSchema.parse(overrides);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    await fs.writeFile(tmp, yaml.dump(validated, { lineWidth: 120, noRefs: true }), { mode: 0o644 });
    await fs.rename(tmp, file);
  });
}

function isEmpty(o: TraefikTenant): boolean {
  return !o.cert_resolver
    && (!o.host_aliases || o.host_aliases.length === 0)
    && (!o.middleware_overrides || Object.keys(o.middleware_overrides).length === 0)
    && (!o.raw_labels || Object.keys(o.raw_labels).length === 0);
}
