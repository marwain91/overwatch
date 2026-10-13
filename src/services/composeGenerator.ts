import * as yaml from 'js-yaml';
import { AppDefinition, AppService } from '../models/app';
import { OverwatchConfig } from '../config/schema';
import type { TraefikTenant } from '../models/traefik';
import { resolveCertResolver, loadConfig } from '../config/loader';
import { buildTraefikLabels } from './traefikLabels';
import { isReservedSecretEnv } from '../utils/reservedEnv';
import { ValidationError } from '../utils/httpErrors';

interface GenerateOptions {
  app: AppDefinition;
  tenantId: string;
  domain: string;
  config: OverwatchConfig;
  /** Optional per-tenant Traefik overrides (host aliases, middleware overrides, raw labels). */
  tenantTraefik?: TraefikTenant;
}

type DependsOnCondition = 'service_completed_successfully' | 'service_started';

interface ComposeHealthcheck {
  test: string[];
  interval: string;
  timeout: string;
  retries: number;
  start_period?: string;
}

interface ComposeService {
  image: string;
  container_name: string;
  restart: 'no' | 'unless-stopped';
  user?: string;
  env_file: string[];
  command?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
  networks: string[];
  healthcheck?: ComposeHealthcheck;
  depends_on?: Record<string, { condition: DependsOnCondition }>;
  labels: string[];
}

type ComposeNetwork = { external: true } | null;
type ComposeVolume = { external: true } | { name: string };

interface ComposeFile {
  services: Record<string, ComposeService>;
  networks: Record<string, ComposeNetwork>;
  volumes?: Record<string, ComposeVolume>;
}

type AppServiceVolume = NonNullable<AppService['volumes']>[number];

/**
 * Generate a tenant docker-compose.yml from app service definitions.
 *
 * The file is built as data and serialised by js-yaml (as infraComposeGenerator
 * does), so no value — service names, env keys, volume paths, label values —
 * can change its structure. `${VAR}` references stay plain strings for compose
 * to interpolate at deploy time.
 */
export function generateComposeFile(options: GenerateOptions): string {
  const { app, tenantId, domain, config, tenantTraefik } = options;
  const prefix = config.project.prefix;
  // Determine the cert resolver name: explicit tenant override > domain pattern > http fallback.
  // For legacy installs (no traefik.cert_resolvers), the resolver helper still works against
  // the synthesized shim; the resulting name is what the legacy tenant.yml template carries.
  let certResolverName: string;
  let certResolverIsRef = false;
  try {
    certResolverName = resolveCertResolver(domain, config.traefik, tenantTraefik?.cert_resolver).name;
  } catch (err) {
    // Fallback for misconfigured legacy installs — old behavior used the env var.
    certResolverName = '${CERT_RESOLVER}';
    certResolverIsRef = true;
  }
  const externalNetwork = config.networking?.external_network || `${prefix}-network`;
  const internalNetworkTemplate = config.networking?.internal_network_template || `${prefix}-\${tenantId}-internal`;
  const internalNetwork = internalNetworkTemplate
    .replace(/\$\{prefix\}/g, prefix)
    .replace(/\$\{tenantId\}/g, tenantId);
  const needsInternalNetwork = app.services.some(s => s.networks?.includes('internal'));
  const imageRegistry = `${app.registry.url}/${app.registry.repository}`;
  const where = `${app.id}/${tenantId}`;

  // Resolve depends_on names against the app's own services so an init
  // container dependency can be rendered with the right wait condition.
  const servicesByName = new Map(app.services.map(s => [s.name, s]));

  // Sort services: non-init first, then init containers
  const sortedServices = [...app.services].sort((a, b) => {
    if (a.is_init_container !== b.is_init_container) {
      return a.is_init_container ? 1 : -1;
    }
    return 0;
  });

  const services = sortedServices.map((service): [string, ComposeService] => {
    const imageName = service.image_suffix || service.name;

    const serviceNetworks = service.networks || ['external'];
    const networks: string[] = [];
    if (serviceNetworks.includes('external')) networks.push(externalNetwork);
    if (serviceNetworks.includes('internal') && needsInternalNetwork) networks.push(internalNetwork);

    // Ownership labels are used by Overwatch for safe Docker discovery and
    // authorization. Keep them on every service, including non-routable workers.
    const labels = [
      'com.overwatch.managed=true',
      `com.overwatch.app-id=${app.id}`,
      `com.overwatch.tenant-id=${tenantId}`,
      `com.overwatch.service=${service.name}`,
      // Traefik labels for routable services (built via traefikLabels.ts)
      ...buildTraefikLabels({
        app,
        tenantId,
        domain,
        service,
        certResolverName,
        traefik: config.traefik,
        tenantOverrides: tenantTraefik,
      }).map(l => escapeLabel(l, certResolverIsRef)),
    ];

    // Keys are written in this order; js-yaml omits the `undefined` ones.
    return [service.name, {
      image: `${imageRegistry}/${imageName}:\${IMAGE_TAG:-${app.default_image_tag}}`,
      container_name: `${app.id}-${tenantId}-${service.name}`,
      restart: service.is_init_container ? 'no' : 'unless-stopped',
      user: service.user || undefined,
      env_file: ['.env', 'shared.env'],
      command: service.command && service.command.length > 0 ? service.command : undefined,
      environment: buildEnvironment(service, { config, domain, service }, where),
      volumes: buildServiceVolumes(service, app.id, tenantId),
      networks,
      healthcheck: buildHealthcheck(service),
      depends_on: buildDependsOn(service, app, servicesByName, where),
      labels,
    }];
  });

  const networks: Array<[string, ComposeNetwork]> = [[externalNetwork, { external: true }]];
  if (needsInternalNetwork) networks.push([internalNetwork, null]);

  const compose: ComposeFile = {
    services: toMapping(services, 'service', where),
    networks: toMapping(networks, 'network', where),
  };
  const volumes = buildVolumeDeclarations(app, tenantId);
  if (volumes.length > 0) compose.volumes = toMapping(volumes, 'volume', where);

  // lineWidth -1 keeps every value (long Traefik rules included) on one line.
  // js-yaml's default compat mode also quotes YAML 1.1 look-alikes ("no",
  // "1000:1000"), so any compose YAML parser reads them back as strings.
  return yaml.dump(compose, { lineWidth: -1, noRefs: true, quotingType: '"' });
}

/** `$` → `$$`: compose reads `$$` as a literal `$` and interpolates a bare `$`. */
function escapeDollar(value: string): string {
  return value.replace(/\$/g, '$$$$');
}

/**
 * Escape a `key=value` label so the value reaches Traefik literally (an
 * `$apr1$` htpasswd hash or a `$1` regex replacement would otherwise be
 * interpolated away). basicauth users written with an already-doubled `$$`
 * (the old manual workaround) are collapsed first so they keep working;
 * `$$` is never valid inside an htpasswd hash.
 */
function escapeLabel(label: string, keepCertResolverRef: boolean): string {
  const eq = label.indexOf('=');
  if (eq < 0) return escapeDollar(label);
  const key = label.slice(0, eq);
  let value = label.slice(eq + 1);
  if (key.endsWith('.basicauth.users')) value = value.replace(/\$\$/g, '$');
  let escaped = escapeDollar(value);
  // The legacy fallback resolver is deliberately a reference into the tenant .env.
  if (keepCertResolverRef) escaped = escaped.split('$${CERT_RESOLVER}').join('${CERT_RESOLVER}');
  return `${key}=${escaped}`;
}

/**
 * Build a YAML mapping from entries. Keys become own data properties, so a
 * name like `__proto__` stays a key. A repeated key throws rather than
 * silently keeping the last value; compose rejects duplicate keys, so such
 * input never deployed when the file was written as text either.
 */
function toMapping<T>(entries: Array<[string, T]>, kind: string, where: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of entries) {
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      throw new Error(`${kind} '${key}' appears more than once in the compose file for ${where}.`);
    }
    Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** Environment variable mapping (auto-resolved where possible). */
function buildEnvironment(
  service: AppService,
  ctx: ResolveContext,
  where: string,
): Record<string, string> | undefined {
  if (!service.env_mapping || Object.keys(service.env_mapping).length === 0) return undefined;
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(service.env_mapping)) {
    // A reserved source would hand an Overwatch secret to the tenant container.
    if (typeof value === 'string' && isReservedSecretEnv(value, ctx.config)) {
      console.warn(`[compose] dropped env_mapping '${key}' on ${where}/${service.name}: source '${value}' is a reserved Overwatch secret`);
      continue;
    }
    entries.push([key, resolveEnvValue(value, ctx)]);
  }
  return entries.length > 0 ? toMapping(entries, 'environment variable', where) : undefined;
}

function resolveVolumeName(vol: AppServiceVolume, appId: string, tenantId: string): string {
  return vol.name_template
    ? vol.name_template.replace(/\$\{appId\}/g, appId).replace(/\$\{tenantId\}/g, tenantId)
    : vol.name;
}

/** The service's `name:path` mounts: its volumes, then backup paths not already mounted. */
function buildServiceVolumes(service: AppService, appId: string, tenantId: string): string[] | undefined {
  const volumes: string[] = [];
  const mountedPaths = new Set<string>();
  for (const vol of service.volumes ?? []) {
    volumes.push(`${resolveVolumeName(vol, appId, tenantId)}:${vol.container_path}`);
    mountedPaths.add(vol.container_path);
  }
  if (service.backup?.enabled && service.backup.paths) {
    for (const p of service.backup.paths) {
      if (mountedPaths.has(p.container)) continue;
      volumes.push(`${service.name}-${p.local}:${p.container}`);
      mountedPaths.add(p.container);
    }
  }
  return volumes.length > 0 ? volumes : undefined;
}

/**
 * Top-level named volume declarations, first declaration of a name wins.
 * Backup volumes follow buildServiceVolumes: a service gets one for each backup
 * path it does not already mount itself, so each one it mounts is declared.
 */
function buildVolumeDeclarations(app: AppDefinition, tenantId: string): Array<[string, ComposeVolume]> {
  const declarations: Array<[string, ComposeVolume]> = [];
  const isDeclared = (name: string) => declarations.some(([declared]) => declared === name);
  for (const service of app.services) {
    const mountedPaths = new Set<string>();
    for (const vol of service.volumes ?? []) {
      const name = resolveVolumeName(vol, app.id, tenantId);
      mountedPaths.add(vol.container_path);
      if (isDeclared(name)) continue;
      declarations.push([name, vol.external === true ? { external: true } : { name }]);
    }
    if (service.backup?.enabled && service.backup.paths) {
      for (const p of service.backup.paths) {
        if (mountedPaths.has(p.container)) continue;
        mountedPaths.add(p.container);
        const name = `${service.name}-${p.local}`;
        if (isDeclared(name)) continue;
        declarations.push([name, { name }]);
      }
    }
  }
  return declarations;
}

function buildHealthcheck(service: AppService): ComposeHealthcheck | undefined {
  const hc = service.health_check;
  if (!hc || service.is_init_container) return undefined;
  const hcPort = hc.port || service.ports?.internal || 80;
  let test: string[];
  if (hc.type === 'http') {
    const url = `http://127.0.0.1:${hcPort}${hc.path || '/health'}`;
    test = hc.tool === 'curl'
      ? ['CMD', 'curl', '-f', url]
      : ['CMD', 'wget', '--spider', '-q', url];
  } else {
    test = ['CMD-SHELL', `nc -z 127.0.0.1 ${hcPort}`];
  }
  return {
    test,
    interval: hc.interval || '30s',
    timeout: '10s',
    retries: 3,
    start_period: hc.start_period || undefined,
  };
}

/**
 * Depends on — always long form.
 *
 * Short-form `depends_on` ("- migrator") only controls START ORDER: it
 * never waits for the dependency to finish and never inspects its exit
 * code. For an init container that is no gating at all — a migrator that
 * died on `sh: drizzle-kit: not found` still let the backend start and
 * report healthy against a schema three migrations old.
 *
 * `service_completed_successfully` makes a non-zero init container abort
 * `docker compose up` and leave dependents unstarted. Compose rejects
 * mixing short and long form inside one block, so every dependency gets an
 * explicit condition; `service_started` is exactly what short form meant,
 * which keeps startup timing unchanged for non-init dependencies.
 */
function buildDependsOn(
  service: AppService,
  app: AppDefinition,
  servicesByName: Map<string, AppService>,
  where: string,
): Record<string, { condition: DependsOnCondition }> | undefined {
  if (!service.depends_on || service.depends_on.length === 0) return undefined;
  const entries = service.depends_on.map((dep): [string, { condition: DependsOnCondition }] => {
    const target = servicesByName.get(dep);
    if (!target) {
      throw new Error(
        `App '${app.id}' service '${service.name}' declares depends_on '${dep}', ` +
        `which is not a known service. Known services: ${app.services.map(s => s.name).join(', ')}.`,
      );
    }
    return [dep, { condition: target.is_init_container ? 'service_completed_successfully' : 'service_started' }];
  });
  return toMapping(entries, `service '${service.name}' dependency`, where);
}

interface ResolveContext {
  config: OverwatchConfig;
  domain: string;
  service: AppService;
}

function resolveEnvValue(
  value: string | { static: string },
  ctx: ResolveContext,
): string {
  // Literal values are escaped so compose does not interpolate a `$` in them;
  // only a named source is deliberately left as a `${NAME}` reference.
  if (typeof value === 'object' && 'static' in value) {
    return escapeDollar(value.static);
  }
  const auto = getAutoResolvedValue(value, ctx);
  if (auto !== undefined) return escapeDollar(auto);
  return `\${${value}}`;
}

function getAutoResolvedValue(
  sourceName: string,
  ctx: ResolveContext,
): string | undefined {
  switch (sourceName) {
    case 'DB_HOST':
      return ctx.config.database.host;
    case 'DB_PORT':
      return String(ctx.config.database.port);
    case 'FRONTEND_URL':
      return `https://${ctx.domain}`;
    case 'BACKEND_URL':
      return `https://${ctx.domain}`;
    case 'PORT':
    case 'BACKEND_PORT':
      return ctx.service.ports ? String(ctx.service.ports.internal) : undefined;
    case 'NODE_ENV':
      return 'production';
    default:
      return undefined;
  }
}

/**
 * Save-time check for env_mapping sources, run by the API and CLI paths that
 * store an app definition. Takes the unparsed `services` because it runs
 * before/alongside schema parsing. Generation drops such entries too, so
 * definitions stored earlier still load.
 */
export function assertAppEnvMappingAllowed(
  services: unknown,
  config?: Parameters<typeof isReservedSecretEnv>[1],
): void {
  if (!Array.isArray(services)) return;
  // Without a config only the static reserved list applies (the DB root
  // password env name is configurable).
  if (config === undefined) {
    try { config = loadConfig(); } catch { config = null; }
  }
  for (const svc of services) {
    const mapping = svc?.env_mapping;
    if (!mapping || typeof mapping !== 'object') continue;
    for (const [key, source] of Object.entries(mapping as Record<string, unknown>)) {
      if (typeof source === 'string' && isReservedSecretEnv(source, config)) {
        throw new ValidationError(
          `env_mapping "${key}" on service "${svc?.name}" cannot read "${source}": it is a reserved Overwatch secret`,
        );
      }
    }
  }
}
