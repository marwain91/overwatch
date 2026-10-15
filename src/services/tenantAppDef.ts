import * as fs from 'fs/promises';
import * as path from 'path';
import { tenantDir, listTenantDirs } from './tenantStore';
import {
  AppDefinition,
  AppDefinitionSchema,
  AppDefinitionStatic,
  AppDefinitionStaticSchema,
} from '../models/app';
import { writeJsonAtomic, readJsonStrict } from '../utils/atomicJson';
import { getApp } from './app';

/**
 * Per-tenant frozen snapshot of the app definition. This isolates tenants
 * that are running different image versions from each other: each tenant's
 * compose regeneration, backup configuration, and service list come from
 * the definition embedded in the image the tenant is actually on. The
 * global apps.d/<id>.json remains the "latest-seen / default-for-new-tenants"
 * view but no longer drives per-tenant behaviour.
 *
 * File lives alongside the tenant's other state:
 *   <appsDir>/<appId>/tenants/<tenantId>/app-definition.json
 *
 * Persists the STATIC shape only (no createdAt/updatedAt). Runtime
 * timestamps are still tracked globally in apps.runtime.json.
 */
const TENANT_APP_DEF_FILE = 'app-definition.json';

function getTenantAppDefPath(appId: string, tenantId: string): string {
  return path.join(tenantDir(appId, tenantId), TENANT_APP_DEF_FILE);
}

/**
 * Read the per-tenant app definition if present. Falls back to the global
 * apps.d/<id>.json when the tenant has no snapshot yet (legacy tenants
 * from pre-v1.6 are seeded at boot, but this keeps the read-path resilient
 * if the seed hasn't run for any reason).
 *
 * Returns null if neither a per-tenant snapshot nor a global entry exists
 * — caller should treat that as "app not found".
 */
export async function readTenantAppDef(
  appId: string,
  tenantId: string,
): Promise<AppDefinition | null> {
  const defPath = getTenantAppDefPath(appId, tenantId);
  try {
    const raw = await readJsonStrict<unknown>(defPath);
    const parsedStatic = AppDefinitionStaticSchema.safeParse(raw);
    if (!parsedStatic.success) {
      const errors = parsedStatic.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
      throw new Error(`${defPath} failed validation: ${errors}`);
    }
    // Rehydrate runtime timestamps from the global runtime store via the
    // full-app helper. We only use its timestamps; the rest is tenant-scoped.
    const globalApp = await getApp(appId);
    const createdAt = globalApp?.createdAt ?? new Date().toISOString();
    const updatedAt = globalApp?.updatedAt ?? createdAt;
    const full: AppDefinition = { ...parsedStatic.data, createdAt, updatedAt };
    const verified = AppDefinitionSchema.safeParse(full);
    if (!verified.success) {
      const errors = verified.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
      throw new Error(`${defPath} (with rehydrated timestamps) failed validation: ${errors}`);
    }
    return verified.data;
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      // No per-tenant snapshot yet — fall back to the global definition.
      return getApp(appId);
    }
    throw err;
  }
}

/**
 * Overlay the global definition onto a tenant snapshot. The snapshot owns the
 * app's shape (services, backup, env_vars, traefik library, db_prefix), so a
 * tenant on an older image keeps working when a newer one changes it. Where
 * images are pulled from (`registry`, `default_image_tag`) and the app's
 * identity (`id`, `name`, `domain_template`) always follow the global
 * definition: an admin's registry switch or an app rename must reach existing
 * tenants. Without a global definition (trashed app) the snapshot is returned
 * as is.
 */
export function overlayGlobalApp<T extends AppDefinition | AppDefinitionStatic>(snapshot: T, global: AppDefinition | null): T {
  if (!global) return snapshot;
  return {
    ...snapshot,
    registry: global.registry,
    default_image_tag: global.default_image_tag,
    id: global.id,
    name: global.name,
    domain_template: global.domain_template,
  } as T;
}

/**
 * The app definition in effect for one tenant: its snapshot (or the global
 * definition for a tenant without one) with `overlayGlobalApp` applied. Null
 * when neither exists. Every per-tenant operation (update, delete, compose
 * regeneration) uses this, so they cannot disagree about the definition.
 */
export async function resolveTenantApp(appId: string, tenantId: string): Promise<AppDefinition | null> {
  const snapshot = await readTenantAppDef(appId, tenantId);
  if (!snapshot) return null;
  return overlayGlobalApp(snapshot, await getApp(appId));
}

/**
 * Write the per-tenant snapshot. Caller supplies the static shape (the
 * thing you'd pass to `overwatch apps apply`). Runtime timestamps are
 * global and not stored per tenant.
 */
export async function writeTenantAppDef(
  appId: string,
  tenantId: string,
  staticDef: AppDefinitionStatic,
): Promise<void> {
  const defPath = getTenantAppDefPath(appId, tenantId);
  // Validate once so we don't write nonsense to disk.
  const parsed = AppDefinitionStaticSchema.safeParse(staticDef);
  if (!parsed.success) {
    const errors = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new Error(`Refusing to write invalid per-tenant definition for ${appId}/${tenantId}: ${errors}`);
  }
  await fs.mkdir(path.dirname(defPath), { recursive: true });
  await writeJsonAtomic(defPath, parsed.data, { mode: 0o644 });
}

/**
 * Seed per-tenant snapshots for every tenant that doesn't have one yet,
 * using the current apps.d/<id>.json as the source. Idempotent — skips
 * tenants that already have a snapshot. Intended to run once at boot
 * after upgrading to v1.6.0, then no-op forever.
 */
export async function seedMissingTenantAppDefs(): Promise<{ seeded: number; skipped: number }> {
  let seeded = 0;
  let skipped = 0;

  const byApp = new Map<string, string[]>();
  for (const t of await listTenantDirs(undefined, { onError: () => {} })) {
    const list = byApp.get(t.appId);
    if (list) list.push(t.tenantId); else byApp.set(t.appId, [t.tenantId]);
  }

  for (const [appId, tenantEntries] of byApp) {
    const app = await getApp(appId);
    if (!app) {
      // The directory exists but the app isn't registered — leave it alone.
      continue;
    }
    const { createdAt: _c, updatedAt: _u, ...staticDef } = app;
    void _c; void _u;

    for (const tenantId of tenantEntries) {
      const defPath = getTenantAppDefPath(appId, tenantId);
      try {
        await fs.access(defPath);
        skipped += 1;
        continue;
      } catch {
        // File missing — seed it.
      }
      await writeTenantAppDef(appId, tenantId, staticDef as AppDefinitionStatic);
      seeded += 1;
    }
  }

  return { seeded, skipped };
}
