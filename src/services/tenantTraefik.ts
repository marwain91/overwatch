import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { tenantDir, listTenantDirs, readTenantEnv } from './tenantStore';
import { loadConfig } from '../config/loader';
import { TraefikTenantSchema, type TraefikTenant } from '../models/traefik';
import { withFileLock } from './fileLock';
import { getApp } from './app';
import { HttpError, ValidationError } from '../utils/httpErrors';

/**
 * Per-tenant Traefik overrides — host aliases, middleware overrides,
 * cert resolver override, raw labels. Stored alongside the tenant's
 * frozen app definition so it survives tenant updates.
 *
 *   <appsDir>/<appId>/tenants/<tenantId>/traefik.yaml
 */
const TENANT_TRAEFIK_FILE = 'traefik.yaml';

function getTenantTraefikPath(appId: string, tenantId: string): string {
  return path.join(tenantDir(appId, tenantId), TENANT_TRAEFIK_FILE);
}

/**
 * Read the tenant's Traefik overrides. Returns undefined when the file
 * doesn't exist (the common case — most tenants don't override anything).
 */
export async function readTenantTraefik(
  appId: string,
  tenantId: string,
  opts: { raw?: boolean } = {},
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
  const data = parsed.data;
  if (opts.raw || !data.host_aliases || data.host_aliases.length === 0) return data;
  // Generation-time re-check: stored aliases may predate the rules, or another
  // tenant may have claimed the host since. Drop what is no longer allowed
  // rather than failing the update.
  let ctx: AliasContext;
  try {
    ctx = await loadAliasContext(appId, tenantId);
  } catch (err: any) {
    // Cannot tell what is safe: fail closed for the aliases, keep the rest.
    console.warn(`[traefik] dropped all host aliases for ${appId}/${tenantId}: ${err?.message || err}`);
    return { ...data, host_aliases: [] };
  }
  const kept: string[] = [];
  for (const alias of data.host_aliases) {
    const problem = aliasProblem(alias, ctx);
    if (problem) {
      console.warn(`[traefik] dropped host alias "${alias}" for ${appId}/${tenantId}: ${problem}`);
    } else {
      kept.push(normalizeHost(alias));
    }
  }
  return { ...data, host_aliases: kept };
}

// ─── Host alias policy ──────────────────────────────────────────────────────

export interface AliasContext {
  /** Hosts Overwatch itself serves (admin, MCP, Traefik dashboard). */
  reservedHosts: Set<string>;
  /** Primary domains and aliases of every other tenant. */
  foreignHosts: Set<string>;
  /** The app's domain_template; a `*.` pattern restricts aliases. */
  domainTemplate?: string;
  allowedAliasDomains: string[];
}

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

const HOSTNAME_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function isValidHostname(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  return host.split('.').every(l => l.length > 0 && l.length <= 63 && HOSTNAME_LABEL_RE.test(l));
}

function isWithin(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Why `alias` may not be routed to this tenant, or undefined when it may. */
export function aliasProblem(alias: string, ctx: AliasContext): string | undefined {
  const host = normalizeHost(alias);
  if (!isValidHostname(host)) return 'not a valid hostname';
  if (ctx.reservedHosts.has(host)) return 'it is a host served by Overwatch itself';
  if (ctx.foreignHosts.has(host)) return 'it is already used by another tenant';
  const tpl = ctx.domainTemplate;
  if (tpl && tpl.startsWith('*.')) {
    const allowed = [tpl.slice(2), ...ctx.allowedAliasDomains].map(normalizeHost);
    if (!allowed.some(d => isWithin(host, d))) {
      return `it is outside the app's domain template (${tpl}); add its domain to traefik.allowed_alias_domains to allow it`;
    }
  }
  return undefined;
}

/** Throws ValidationError naming the first bad alias; returns the normalised aliases. */
export function assertHostAliasesAllowed(aliases: string[], ctx: AliasContext): string[] {
  for (const alias of aliases) {
    const problem = aliasProblem(alias, ctx);
    if (problem) throw new ValidationError(`Host alias "${alias}" is not allowed: ${problem}`);
  }
  return [...new Set(aliases.map(normalizeHost))];
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try { return normalizeHost(new URL(url).hostname); } catch { return undefined; }
}

const ABSENT = new Set(['ENOENT', 'ENOTDIR']);
function failClosed(what: string, err: any): HttpError {
  return new HttpError(500, `Cannot check host aliases: ${what} could not be read (${err?.code || err?.message || err})`, { expose: true });
}

/** A genuinely absent file/dir is "none"; any other failure must not read as "no foreign hosts". */
async function readIfExists(file: string): Promise<string | undefined> {
  try { return await fs.readFile(file, 'utf-8'); } catch (err: any) {
    if (ABSENT.has(err?.code)) return undefined;
    throw failClosed(path.basename(path.dirname(file)) + '/' + path.basename(file), err);
  }
}

/**
 * Collect everything an alias of (appId, tenantId) must not collide with.
 * Foreign hosts come from the tenants' own files (`.env` TENANT_DOMAIN and
 * traefik.yaml), so no Docker access is needed.
 */
export async function loadAliasContext(appId: string, tenantId: string): Promise<AliasContext> {
  // Fails closed: without the config the reserved hosts are unknown.
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch {
    throw new HttpError(500, 'Cannot check host aliases: the Overwatch configuration could not be loaded', { expose: true });
  }

  const reserved = new Set<string>();
  for (const h of [hostOf(config?.mcp?.public_url), config?.traefik?.overwatch?.host, config?.traefik?.dashboard?.host]) {
    if (h) reserved.add(normalizeHost(h));
  }

  const foreign = new Set<string>();
  let tenants;
  try { tenants = await listTenantDirs(); } catch (err) { throw failClosed('the apps directory', err); }
  for (const { appId: a, tenantId: t, dir } of tenants) {
    if (a === appId && t === tenantId) continue;
    let domain: string | undefined;
    try {
      domain = (await readTenantEnv(a, t)).TENANT_DOMAIN;
    } catch (err: any) {
      if (!ABSENT.has(err?.code)) throw failClosed(`${t}/.env`, err);
    }
    if (domain) foreign.add(normalizeHost(domain));
    const raw = await readIfExists(path.join(dir, TENANT_TRAEFIK_FILE));
    if (raw) {
      try {
        const aliases = (yaml.load(raw) as any)?.host_aliases;
        if (Array.isArray(aliases)) for (const x of aliases) if (typeof x === 'string') foreign.add(normalizeHost(x));
      } catch (err) { throw failClosed(`${a}/${t}/${TENANT_TRAEFIK_FILE}`, err); }
    }
  }

  const app = await getApp(appId);
  if (!app) throw new HttpError(500, `Cannot check host aliases: app '${appId}' is not defined`, { expose: true });
  return {
    reservedHosts: reserved,
    foreignHosts: foreign,
    domainTemplate: app.domain_template,
    allowedAliasDomains: config?.traefik?.allowed_alias_domains ?? [],
  };
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
