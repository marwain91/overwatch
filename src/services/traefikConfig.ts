import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { findConfigPath, loadConfig, clearConfigCache } from '../config/loader';
import { OverwatchConfigSchema } from '../config/schema';
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
import { TraefikAppSchema, type TraefikApp } from '../models/traefik';
import { readTenantTraefik, writeTenantTraefik } from './tenantTraefik';
import type { TraefikTenant } from '../models/traefik';

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

/**
 * Load the raw overwatch.yaml as a JS object. Read+write helpers below preserve
 * the existing YAML for keys we don't touch.
 */
async function readRawConfig(): Promise<Record<string, any>> {
  const configPath = findConfigPath();
  const content = await fs.readFile(configPath, 'utf-8');
  return (yaml.load(content) as Record<string, any>) ?? {};
}

async function writeRawConfig(updated: Record<string, any>): Promise<void> {
  // Validate the merged shape against the full schema before persisting.
  const parse = OverwatchConfigSchema.safeParse(updated);
  if (!parse.success) {
    const errors = parse.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
    throw new Error(`Resulting overwatch.yaml would be invalid: ${errors}`);
  }
  const configPath = findConfigPath();
  const tmp = `${configPath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, yaml.dump(updated, { lineWidth: 120, noRefs: true }), { mode: 0o644 });
  await fs.rename(tmp, configPath);
  clearConfigCache();
}

// ─── Global Traefik config ──────────────────────────────────────────────────

export async function getTraefikConfig(opts: { unmask?: boolean } = {}): Promise<TraefikGlobal | undefined> {
  const cfg = loadConfig();
  return opts.unmask ? cfg.traefik : maskTraefikSecrets(cfg.traefik);
}

export async function updateTraefikConfig(patch: TraefikGlobal): Promise<TraefikGlobal> {
  const validated = TraefikGlobalSchema.parse(patch);
  const raw = await readRawConfig();
  raw.traefik = validated;
  await writeRawConfig(raw);
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
  const raw = await readRawConfig();
  raw.traefik = raw.traefik ?? {};
  const list: CertResolver[] = raw.traefik.cert_resolvers ?? [];
  const idx = list.findIndex(r => r.name === name);
  if (idx >= 0) {
    list[idx] = validated;
  } else {
    list.push(validated);
  }
  raw.traefik.cert_resolvers = list;
  await writeRawConfig(raw);
  return validated;
}

export async function deleteCertResolver(name: string): Promise<void> {
  const raw = await readRawConfig();
  if (!raw.traefik?.cert_resolvers) return;
  raw.traefik.cert_resolvers = raw.traefik.cert_resolvers.filter((r: CertResolver) => r.name !== name);
  await writeRawConfig(raw);
}

// ─── Global middleware library ──────────────────────────────────────────────

export async function listGlobalMiddlewares(): Promise<Record<string, MiddlewareSpec>> {
  const t = await getTraefikConfig();
  return t?.middlewares ?? {};
}

export async function upsertGlobalMiddleware(name: string, body: unknown): Promise<MiddlewareSpec> {
  const validated = MiddlewareSpecSchema.parse(body);
  const raw = await readRawConfig();
  raw.traefik = raw.traefik ?? {};
  raw.traefik.middlewares = raw.traefik.middlewares ?? {};
  raw.traefik.middlewares[name] = validated;
  await writeRawConfig(raw);
  return validated;
}

export async function deleteGlobalMiddleware(name: string): Promise<void> {
  const raw = await readRawConfig();
  if (!raw.traefik?.middlewares) return;
  delete raw.traefik.middlewares[name];
  await writeRawConfig(raw);
}

// ─── Dashboard ──────────────────────────────────────────────────────────────

export async function getDashboardConfig() {
  const t = await getTraefikConfig();
  return t?.dashboard;
}

export async function updateDashboardConfig(body: unknown) {
  const validated = TraefikDashboardSchema.parse(body);
  const raw = await readRawConfig();
  raw.traefik = raw.traefik ?? {};
  raw.traefik.dashboard = validated;
  await writeRawConfig(raw);
  return validated;
}

// ─── Overwatch self-routing ─────────────────────────────────────────────────

export async function getOverwatchRouting() {
  const t = await getTraefikConfig();
  return t?.overwatch;
}

export async function updateOverwatchRouting(body: unknown) {
  const validated = TraefikOverwatchSchema.parse(body);
  const raw = await readRawConfig();
  raw.traefik = raw.traefik ?? {};
  raw.traefik.overwatch = validated;
  await writeRawConfig(raw);
  return validated;
}

// ─── Per-app Traefik ────────────────────────────────────────────────────────

export async function getAppTraefik(appId: string): Promise<TraefikApp | undefined> {
  const app = await getApp(appId);
  if (!app) throw new Error(`App '${appId}' not found`);
  return app.traefik;
}

export async function updateAppTraefik(appId: string, body: unknown): Promise<TraefikApp> {
  const validated = TraefikAppSchema.parse(body);
  const app = await getApp(appId);
  if (!app) throw new Error(`App '${appId}' not found`);
  const { createdAt: _c, updatedAt: _u, ...staticPart } = app;
  void _c; void _u;
  await applyApp({ ...staticPart, traefik: validated }, 'api:traefik-update');
  return validated;
}

// ─── Per-tenant Traefik ─────────────────────────────────────────────────────

export async function getTenantTraefik(appId: string, tenantId: string): Promise<TraefikTenant | undefined> {
  return readTenantTraefik(appId, tenantId);
}

export async function updateTenantTraefik(appId: string, tenantId: string, body: unknown): Promise<TraefikTenant | undefined> {
  if (body === null || body === undefined) {
    await writeTenantTraefik(appId, tenantId, undefined);
    return undefined;
  }
  await writeTenantTraefik(appId, tenantId, body as TraefikTenant);
  return readTenantTraefik(appId, tenantId);
}
