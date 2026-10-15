import * as yaml from 'js-yaml';
import { AppDefinition, AppService } from '../models/app';
import { OverwatchConfig } from '../config/schema';
import type { TraefikTenant } from '../models/traefik';
import { resolveCertResolver } from '../config/loader';
import { buildTraefikLabels } from './traefikLabels';
import { isValidComposeDuration, isSafeVolumeName } from '../utils/validators';
import { containerName, tenantVolumeName, isTenantOwnedVolume } from './tenantIdentity';

interface GenerateOptions {
  app: AppDefinition;
  tenantId: string;
  domain: string;
  config: OverwatchConfig;
  /** Optional per-tenant Traefik overrides (host aliases, middleware overrides, raw labels). */
  tenantTraefik?: TraefikTenant;
  /**
   * The tenant's current docker-compose.yml, when it has one. Volume names it
   * already declares are kept, so regenerating never moves a tenant's data.
   */
  existingCompose?: string;
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
  const volumeNamer = createVolumeNamer(app.id, tenantId, options.existingCompose, where);

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
      `com.overwatch.service=${escapeDollar(service.name)}`,
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
      container_name: containerName(app.id, tenantId, service.name),
      restart: service.is_init_container ? 'no' : 'unless-stopped',
      user: service.user || undefined,
      env_file: ['.env', 'shared.env'],
      command: service.command && service.command.length > 0 ? service.command : undefined,
      environment: buildEnvironment(service, { config, domain, service }, where),
      volumes: buildServiceVolumes(service, volumeNamer),
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
  const volumes = buildVolumeDeclarations(app, volumeNamer);
  if (volumes.length > 0) compose.volumes = toMapping(volumes, 'volume', where);

  // lineWidth -1 keeps every value (long Traefik rules included) on one line.
  // js-yaml's default compat mode also quotes YAML 1.1 look-alikes ("no",
  // "1000:1000"), so any compose YAML parser reads them back as strings.
  return yaml.dump(compose, { lineWidth: -1, noRefs: true, quotingType: '"' });
}

export interface DeclaredVolume {
  /** Key under the top-level `volumes:` mapping (what service mounts refer to). */
  key: string;
  /** Docker volume name: `name:` when set, otherwise the key. */
  name: string;
  external: boolean;
}

/**
 * The container names and top-level volumes a tenant compose file declares.
 * Throws when the text is not a YAML mapping, so a caller never mistakes an
 * unreadable file for one without volumes.
 */
export function readComposeNames(composeText: string): { containerNames: string[]; volumes: DeclaredVolume[] } {
  const doc = yaml.load(composeText);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('compose file is not a YAML mapping');
  }
  const { services, volumes } = doc as { services?: unknown; volumes?: unknown };
  const containerNames: string[] = [];
  if (services && typeof services === 'object') {
    for (const svc of Object.values(services as Record<string, unknown>)) {
      const name = (svc as { container_name?: unknown } | null)?.container_name;
      if (typeof name === 'string') containerNames.push(name);
    }
  }
  const declared: DeclaredVolume[] = [];
  if (volumes && typeof volumes === 'object') {
    for (const [key, def] of Object.entries(volumes as Record<string, unknown>)) {
      const d = def && typeof def === 'object' ? def as { name?: unknown; external?: unknown } : {};
      // `external: { name: x }` is the old compose spelling of an external volume's name.
      const externalObject = !!d.external && typeof d.external === 'object';
      const legacyName = externalObject ? (d.external as { name?: unknown }).name : undefined;
      const name = typeof d.name === 'string' ? d.name : typeof legacyName === 'string' ? legacyName : key;
      declared.push({ key, name, external: d.external === true || externalObject });
    }
  }
  return { containerNames, volumes: declared };
}

/**
 * A tenant compose file for a destructive `down -v`: every declared volume the
 * tenant does not own becomes external, so compose leaves it alone. Needed for
 * compose files written before tenant-scoped names, whose unscoped volumes may
 * hold other tenants' data. Returns null when nothing needs changing.
 */
export function protectUnownedVolumes(composeText: string, appId: string, tenantId: string): string | null {
  const unowned = readComposeNames(composeText).volumes
    .filter(v => !v.external && !isTenantOwnedVolume(v.name, appId, tenantId));
  if (unowned.length === 0) return null;
  const doc = yaml.load(composeText) as { volumes: Record<string, unknown> };
  for (const v of unowned) {
    Object.defineProperty(doc.volumes, v.key, { value: { external: true, name: v.name }, enumerable: true, writable: true, configurable: true });
  }
  return yaml.dump(doc, { lineWidth: -1, noRefs: true, quotingType: '"' });
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
    entries.push([key, resolveEnvValue(value, ctx)]);
  }
  return toMapping(entries, 'environment variable', where);
}

interface VolumeChoice {
  name: string;
  declaration: ComposeVolume;
}

interface VolumeNamer {
  volume(vol: AppServiceVolume): VolumeChoice;
  backup(serviceName: string, local: string): VolumeChoice;
}

/**
 * Decide the Docker volume behind each mount. Compose does not prefix a volume
 * declared with an explicit `name:` with the project, so a name without the
 * tenant in it is one volume shared by every tenant that declares it.
 *
 * - Tenant-owned names (`<appId>-<tenantId>-…`) are left to compose, which
 *   creates them and removes them on `down -v`.
 * - A `volumes[]` entry without `name_template`, and a backup path the
 *   service does not mount itself, get an owned name for a new tenant. An
 *   existing tenant whose compose file already declares the old unscoped
 *   name keeps it (its data lives there), declared external.
 * - Any other name is shared on purpose (`external: true`, or a template
 *   without both placeholders) and declared external, so compose never
 *   creates or deletes it with one tenant (ensureExternalVolumes creates it).
 */
function createVolumeNamer(appId: string, tenantId: string, existingCompose: string | undefined, where: string): VolumeNamer {
  let existing: Set<string> | undefined;
  if (existingCompose !== undefined) {
    try {
      existing = new Set(readComposeNames(existingCompose).volumes.map(v => v.name));
    } catch (err: any) {
      throw new Error(
        `The existing docker-compose.yml of ${where} could not be read (${err?.message || err}); ` +
        'refusing to regenerate it, because its volume names could change.',
      );
    }
  }
  const warned = new Set<string>();
  const warnOnce = (name: string, message: string) => {
    if (warned.has(name)) return;
    warned.add(name);
    console.warn(message);
  };
  const external = (name: string): VolumeChoice => ({ name, declaration: { external: true } });

  // Stored definitions may predate write-path validation. Such a name stays
  // exactly as before (a scoped prefix would not make a path a volume).
  const unsafe = (name: string): boolean => {
    if (isSafeVolumeName(name)) return false;
    warnOnce(name, `[compose] ${where}: volume name ${JSON.stringify(name)} is not a plain Docker volume name, so Docker mounts it as a host path or rejects it. Change it in the app definition.`);
    return true;
  };

  const unscoped = (legacyName: string): VolumeChoice => {
    if (unsafe(legacyName)) return { name: legacyName, declaration: { name: legacyName } };
    if (existing?.has(legacyName)) {
      warnOnce(legacyName,
        `[compose] ${where} uses the shared legacy volume '${legacyName}': every tenant whose compose file declares it shares its files. ` +
        'It is declared external, so Overwatch never creates or deletes it with this tenant. ' +
        'See "Shared legacy volumes" in docs/troubleshooting.md to give the tenant its own volume.');
      return external(legacyName);
    }
    const name = tenantVolumeName(appId, tenantId, legacyName);
    return { name, declaration: { name } };
  };

  return {
    volume(vol) {
      if (vol.external === true) {
        const name = vol.name_template ? fillTemplate(vol.name_template, appId, tenantId) : vol.name;
        unsafe(name);
        return external(name);
      }
      if (!vol.name_template) return unscoped(vol.name);
      const name = fillTemplate(vol.name_template, appId, tenantId);
      if (unsafe(name)) return { name, declaration: { name } };
      if (isTenantOwnedVolume(name, appId, tenantId)) return { name, declaration: { name } };
      warnOnce(name,
        `[compose] ${where}: volume '${name}' (name_template ${JSON.stringify(vol.name_template)}) is not scoped to this tenant, so tenants share it; ` +
        'it is declared external, so Overwatch never creates or deletes it with this tenant.');
      return external(name);
    },
    backup(serviceName, local) {
      return unscoped(`${serviceName}-${local}`);
    },
  };
}

function fillTemplate(template: string, appId: string, tenantId: string): string {
  return template.replace(/\$\{appId\}/g, appId).replace(/\$\{tenantId\}/g, tenantId);
}

/** The service's `name:path` mounts: its volumes, then backup paths not already mounted. */
function buildServiceVolumes(service: AppService, namer: VolumeNamer): string[] | undefined {
  const volumes: string[] = [];
  const mountedPaths = new Set<string>();
  for (const vol of service.volumes ?? []) {
    volumes.push(`${namer.volume(vol).name}:${vol.container_path}`);
    mountedPaths.add(vol.container_path);
  }
  if (service.backup?.enabled && service.backup.paths) {
    for (const p of service.backup.paths) {
      if (mountedPaths.has(p.container)) continue;
      volumes.push(`${namer.backup(service.name, p.local).name}:${p.container}`);
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
function buildVolumeDeclarations(app: AppDefinition, namer: VolumeNamer): Array<[string, ComposeVolume]> {
  const declarations: Array<[string, ComposeVolume]> = [];
  const declare = ({ name, declaration }: VolumeChoice) => {
    if (!declarations.some(([declared]) => declared === name)) declarations.push([name, declaration]);
  };
  for (const service of app.services) {
    const mountedPaths = new Set<string>();
    for (const vol of service.volumes ?? []) {
      mountedPaths.add(vol.container_path);
      declare(namer.volume(vol));
    }
    if (service.backup?.enabled && service.backup.paths) {
      for (const p of service.backup.paths) {
        if (mountedPaths.has(p.container)) continue;
        mountedPaths.add(p.container);
        declare(namer.backup(service.name, p.local));
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
  // Stored definitions may predate write-path validation. An invalid duration
  // would make `docker compose up` reject the whole file, so warn and fall back.
  const duration = (field: 'interval' | 'start_period', fallback: string | undefined) => {
    const value = hc[field];
    if (!value) return fallback;
    if (isValidComposeDuration(value)) return value;
    console.warn(`[compose] ignoring invalid health_check.${field} ${JSON.stringify(value)} on service '${service.name}'${fallback ? ` (using ${fallback})` : ''}`);
    return fallback;
  };
  return {
    test,
    interval: duration('interval', '30s')!,
    timeout: '10s',
    retries: 3,
    start_period: duration('start_period', undefined),
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
