import { isDeepStrictEqual } from 'util';
import { AppDefinitionStatic, AppService, AppServiceRoutingSchema } from '../models/app';

type AppServiceRouting = NonNullable<AppService['routing']>;
type Fields = Record<string, unknown>;

// Anyone who can push a tag to an app's registry controls the image's
// /overwatch/app.json, and it lands in the definition every tenant of the app
// shares. The image may describe its own shape (services, ports, health
// checks, env declarations, routing paths); who can get in, where data lives
// and how containers run stay as an admin set them in Overwatch.
const PROTECTED_APP_FIELDS = [
  'admin_access', 'backup', 'credentials', 'db_prefix', 'traefik',
] as const satisfies readonly (keyof AppDefinitionStatic)[];
const PROTECTED_SERVICE_FIELDS = [
  'user', 'command', 'volumes', 'networks', 'backup',
] as const satisfies readonly (keyof AppService)[];
const PROTECTED_ROUTING_FIELDS = [
  'raw_labels', 'tls_termination',
] as const satisfies readonly (keyof AppServiceRouting)[];

export interface ManifestPolicyResult {
  next: AppDefinitionStatic;
  /** Dotted paths whose manifest value differed from the kept value. */
  ignored: string[];
}

/**
 * Apply an image manifest to the current app definition, keeping protected
 * fields at their current value (or dropping them when there is none: a new
 * app or a service the manifest adds). Identity and registry fields are not
 * handled here; callers overlay those from the global definition.
 * Inputs are not modified.
 */
export function applyManifestPolicy(
  current: AppDefinitionStatic | null,
  manifest: AppDefinitionStatic,
): ManifestPolicyResult {
  const ignored: string[] = [];
  const next: Fields = { ...manifest };
  for (const field of PROTECTED_APP_FIELDS) {
    keepCurrent(next, manifest, current ?? undefined, field, field, ignored);
  }
  next.services = manifest.services.map(service =>
    applyServicePolicy(service, current?.services.find(s => s.name === service.name), ignored));
  return { next: next as AppDefinitionStatic, ignored };
}

/**
 * The definition protected values come from during a tenant update: the
 * admin-controlled global definition, plus services only this tenant's
 * snapshot still has (a newer image on another tenant removed them
 * globally), so a tenant on an older release keeps their volumes and
 * command instead of having them stripped as if the service were new.
 */
export function manifestPolicyBaseline(
  global: AppDefinitionStatic | null,
  tenantSnapshot: AppDefinitionStatic,
): AppDefinitionStatic {
  if (!global) return tenantSnapshot;
  const globalNames = new Set(global.services.map(s => s.name));
  return {
    ...global,
    services: [...global.services, ...tenantSnapshot.services.filter(s => !globalNames.has(s.name))],
  };
}

function applyServicePolicy(service: AppService, current: AppService | undefined, ignored: string[]): AppService {
  const path = `services.${service.name}`;
  const next: Fields = { ...service };
  for (const field of PROTECTED_SERVICE_FIELDS) {
    keepCurrent(next, service, current, field, `${path}.${field}`, ignored);
  }
  const routing = applyRoutingPolicy(service.routing, current?.routing, `${path}.routing`, ignored);
  if (routing) next.routing = routing;
  return next as AppService;
}

function applyRoutingPolicy(
  routing: AppServiceRouting | undefined,
  current: AppServiceRouting | undefined,
  path: string,
  ignored: string[],
): AppServiceRouting | undefined {
  const hasProtected = PROTECTED_ROUTING_FIELDS.some(field => current?.[field] !== undefined);
  if (!routing && !hasProtected) return undefined;
  // Routing belongs to the image, but leaving the block out must not drop the
  // admin's labels or TLS mode. An empty block parses to the same defaults an
  // absent one implies (routed, no prefix stripping).
  const next: Fields = { ...(routing ?? AppServiceRoutingSchema.parse({})) };
  for (const field of PROTECTED_ROUTING_FIELDS) {
    keepCurrent(next, routing, current, field, `${path}.${field}`, ignored);
  }
  return next as AppServiceRouting;
}

/**
 * Set `key` on `target` to the current value, or remove it when there is
 * none. A manifest that leaves the key out has no opinion, so only a value it
 * supplies that differs is reported.
 */
function keepCurrent(
  target: Fields,
  manifest: Fields | undefined,
  current: Fields | undefined,
  key: string,
  path: string,
  ignored: string[],
): void {
  const manifestValue = manifest?.[key];
  const currentValue = current?.[key];
  if (manifestValue !== undefined && !isDeepStrictEqual(manifestValue, currentValue)) {
    ignored.push(path);
  }
  if (currentValue === undefined) delete target[key];
  else target[key] = currentValue;
}
