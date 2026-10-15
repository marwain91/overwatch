import { loadConfig } from '../config/loader';
import { updateOverwatchConfig } from '../config/writer';
import {
  TraefikGlobalSchema,
  TraefikDashboardSchema,
  TraefikOverwatchSchema,
  CertResolverSchema,
  MiddlewareSpecSchema,
  type TraefikGlobal,
  type CertResolver,
  type MiddlewareSpec,
} from '../models/traefik';
import { getApp, applyApp } from './app';
import { TraefikAppSchema, TraefikTenantSchema, type TraefikApp } from '../models/traefik';
import { readTenantTraefik, writeTenantTraefik, loadAliasContext, assertHostAliasesAllowed } from './tenantTraefik';
import type { TraefikTenant } from '../models/traefik';
import { NotFoundError } from '../utils/httpErrors';
import { tenantDir, readTenantEnv } from './tenantStore';
import * as fs from 'fs/promises';
import { assertTenantRawLabelsOwned, assertNoGlobalMiddlewareShadowing, globalDefaultMiddlewares } from './traefikLabels';
import {
  restoreMiddlewareCredentials,
  restoreRoutingCredentials,
  restoreTenantTraefik,
} from './traefikRedaction';

const SECRET_HINTS = /(_TOKEN|_KEY|_SECRET|_PASSWORD)$/;

/**
 * Mask sensitive cert-resolver env values for read APIs. Mirrors the masking
 * pattern used by EnvironmentPage: keys that look secret have their value
 * replaced with bullets in the response body.
 */
export function maskTraefikSecrets(t: TraefikGlobal | undefined): TraefikGlobal | undefined {
  if (!t?.cert_resolvers) return t;
  const masked: TraefikGlobal = JSON.parse(JSON.stringify(t));
  for (const r of masked.cert_resolvers ?? []) {
    if (r.challenge !== 'dns' || !r.env) continue;
    for (const k of Object.keys(r.env)) {
      if (SECRET_HINTS.test(k)) {
        r.env[k] = '••••••••';
      }
    }
  }
  return masked;
}

// ─── Global Traefik config ──────────────────────────────────────────────────

export async function getTraefikConfig(opts: { unmask?: boolean } = {}): Promise<TraefikGlobal | undefined> {
  const cfg = loadConfig();
  return opts.unmask ? cfg.traefik : maskTraefikSecrets(cfg.traefik);
}

export async function updateTraefikConfig(patch: TraefikGlobal): Promise<TraefikGlobal> {
  const validated = TraefikGlobalSchema.parse(patch);
  const stored = loadConfig().traefik;
  if (validated.middlewares) validated.middlewares = restoreMiddlewareCredentials(validated.middlewares, stored?.middlewares);
  if (validated.overwatch) validated.overwatch = restoreRoutingCredentials(validated.overwatch, stored?.overwatch);
  if (validated.dashboard) validated.dashboard = restoreRoutingCredentials(validated.dashboard, stored?.dashboard);
  await updateOverwatchConfig(raw => { raw.traefik = validated; });
  return validated;
}

// ─── Cert resolvers ─────────────────────────────────────────────────────────

export async function listCertResolvers(opts: { unmask?: boolean } = {}): Promise<CertResolver[]> {
  const t = await getTraefikConfig(opts);
  return t?.cert_resolvers ?? [];
}

export async function upsertCertResolver(name: string, body: unknown): Promise<CertResolver> {
  // Force the URL-path name onto the body to avoid mismatches.
  const bodyWithName = { ...(body as Record<string, unknown>), name };
  const validated = CertResolverSchema.parse(bodyWithName);
  await updateOverwatchConfig(raw => {
    raw.traefik = raw.traefik ?? {};
    const list: CertResolver[] = raw.traefik.cert_resolvers ?? [];
    const idx = list.findIndex(r => r.name === name);
    if (idx >= 0) {
      list[idx] = validated;
    } else {
      list.push(validated);
    }
    raw.traefik.cert_resolvers = list;
  });
  return validated;
}

export async function deleteCertResolver(name: string): Promise<void> {
  await updateOverwatchConfig(raw => {
    if (!raw.traefik?.cert_resolvers) return;
    raw.traefik.cert_resolvers = raw.traefik.cert_resolvers.filter((r: CertResolver) => r.name !== name);
  });
}

// ─── Global middleware library ──────────────────────────────────────────────

export async function listGlobalMiddlewares(): Promise<Record<string, MiddlewareSpec>> {
  const t = await getTraefikConfig();
  return t?.middlewares ?? {};
}

export async function upsertGlobalMiddleware(name: string, body: unknown): Promise<MiddlewareSpec> {
  const parsed = MiddlewareSpecSchema.parse(body);
  const stored = loadConfig().traefik?.middlewares;
  const validated = restoreMiddlewareCredentials({ [name]: parsed }, stored)[name];
  await updateOverwatchConfig(raw => {
    raw.traefik = raw.traefik ?? {};
    raw.traefik.middlewares = raw.traefik.middlewares ?? {};
    raw.traefik.middlewares[name] = validated;
  });
  return validated;
}

export async function deleteGlobalMiddleware(name: string): Promise<void> {
  await updateOverwatchConfig(raw => {
    if (!raw.traefik?.middlewares) return;
    delete raw.traefik.middlewares[name];
  });
}

// ─── Dashboard ──────────────────────────────────────────────────────────────

export async function getDashboardConfig() {
  const t = await getTraefikConfig();
  return t?.dashboard;
}

export async function updateDashboardConfig(body: unknown) {
  const validated = restoreRoutingCredentials(TraefikDashboardSchema.parse(body), loadConfig().traefik?.dashboard);
  await updateOverwatchConfig(raw => {
    raw.traefik = raw.traefik ?? {};
    raw.traefik.dashboard = validated;
  });
  return validated;
}

// ─── Overwatch self-routing ─────────────────────────────────────────────────

export async function getOverwatchRouting() {
  const t = await getTraefikConfig();
  return t?.overwatch;
}

export async function updateOverwatchRouting(body: unknown) {
  const validated = restoreRoutingCredentials(TraefikOverwatchSchema.parse(body), loadConfig().traefik?.overwatch);
  await updateOverwatchConfig(raw => {
    raw.traefik = raw.traefik ?? {};
    raw.traefik.overwatch = validated;
  });
  return validated;
}

// ─── Per-app Traefik ────────────────────────────────────────────────────────

export async function getAppTraefik(appId: string): Promise<TraefikApp | undefined> {
  const app = await getApp(appId);
  if (!app) throw new NotFoundError(`App '${appId}' not found`);
  return app.traefik;
}

export async function updateAppTraefik(appId: string, body: unknown): Promise<TraefikApp> {
  const parsed = TraefikAppSchema.parse(body);
  const app = await getApp(appId);
  if (!app) throw new NotFoundError(`App '${appId}' not found`);
  assertNoGlobalMiddlewareShadowing(parsed, loadConfig().traefik);
  const { createdAt: _c, updatedAt: _u, ...staticPart } = app;
  void _c; void _u;
  // A body built from a masked (non-admin) read carries the placeholder; the stored
  // hashes are restored inside applyApp's lock so a concurrent rotation is not reverted.
  const { app: saved } = await applyApp({ ...staticPart, traefik: parsed }, 'api:traefik-update', {
    restore: (candidate, stored) => {
      const t = (candidate as { traefik: TraefikApp }).traefik;
      const middlewares = restoreMiddlewareCredentials(t.middlewares, stored?.traefik?.middlewares);
      return { ...(candidate as object), traefik: { ...t, ...(middlewares ? { middlewares } : {}) } };
    },
  });
  return saved.traefik ?? {};
}

// ─── Per-tenant Traefik ─────────────────────────────────────────────────────

export async function getTenantTraefik(appId: string, tenantId: string): Promise<TraefikTenant | undefined> {
  // Stored aliases are shown as stored, even ones generation would now drop.
  return readTenantTraefik(appId, tenantId, { raw: true });
}

export async function updateTenantTraefik(appId: string, tenantId: string, body: unknown): Promise<TraefikTenant | undefined> {
  if (body === null || body === undefined) {
    await writeTenantTraefik(appId, tenantId, undefined);
    return undefined;
  }
  // Writing would otherwise create the tenant directory, and its aliases would then count as foreign hosts.
  try {
    await fs.access(tenantDir(appId, tenantId));
  } catch (err: any) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') throw new NotFoundError(`Tenant '${tenantId}' not found in app '${appId}'`);
    throw err;
  }
  const incoming = TraefikTenantSchema.parse(body);
  // Restoring masked credentials reads the stored value, so it runs under the write lock.
  await writeTenantTraefik(appId, tenantId, async (stored) => {
    const parsed = restoreTenantTraefik(incoming, stored);
    if (parsed.host_aliases && parsed.host_aliases.length > 0) {
      parsed.host_aliases = assertHostAliasesAllowed(parsed.host_aliases, await loadAliasContext(appId, tenantId));
    }
    if (parsed.raw_labels) {
      // A tenant label may redirect only to the tenant's own hosts, aliases saved with it included.
      const domain = await readTenantEnv(appId, tenantId).then(env => env.TENANT_DOMAIN, (err: any) => {
        if (err?.code === 'ENOENT') return undefined;
        throw err;
      });
      assertTenantRawLabelsOwned(appId, tenantId, parsed.raw_labels, {
        hosts: [...(domain ? [domain] : []), ...(parsed.host_aliases ?? [])],
        globalDefaults: globalDefaultMiddlewares((await getApp(appId)) ?? undefined, loadConfig().traefik),
      });
    }
    return parsed;
  });
  return readTenantTraefik(appId, tenantId, { raw: true });
}
