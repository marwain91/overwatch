import { AppDefinition, AppService } from '../models/app';
import { OverwatchConfig } from '../config/schema';
import type { TraefikTenant } from '../models/traefik';
import { resolveCertResolver } from '../config/loader';
import { buildTraefikLabels } from './traefikLabels';

/** Escape a value for safe use inside a double-quoted YAML string */
function yamlEscape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

function labelLine(key: string, value: string): string {
  return `      - "${yamlEscape(`${key}=${value}`)}"`;
}

interface GenerateOptions {
  app: AppDefinition;
  tenantId: string;
  domain: string;
  config: OverwatchConfig;
  /** Optional per-tenant Traefik overrides (host aliases, middleware overrides, raw labels). */
  tenantTraefik?: TraefikTenant;
}

/**
 * Generate a docker-compose.yml content from app service definitions.
 * Produces YAML as a string (no external YAML library dependency needed).
 */
export function generateComposeFile(options: GenerateOptions): string {
  const { app, tenantId, domain, config, tenantTraefik } = options;
  const prefix = config.project.prefix;
  // Determine the cert resolver name: explicit tenant override > domain pattern > http fallback.
  // For legacy installs (no traefik.cert_resolvers), the resolver helper still works against
  // the synthesized shim; the resulting name is what the legacy tenant.yml template carries.
  let certResolverName: string;
  try {
    certResolverName = resolveCertResolver(domain, config.traefik, tenantTraefik?.cert_resolver).name;
  } catch (err) {
    // Fallback for misconfigured legacy installs — old behavior used the env var.
    certResolverName = '${CERT_RESOLVER}';
  }
  const externalNetwork = config.networking?.external_network || `${prefix}-network`;
  const internalNetworkTemplate = config.networking?.internal_network_template || `${prefix}-\${tenantId}-internal`;
  const internalNetwork = internalNetworkTemplate
    .replace(/\$\{prefix\}/g, prefix)
    .replace(/\$\{tenantId\}/g, tenantId);
  const needsInternalNetwork = app.services.some(s => s.networks?.includes('internal'));
  const imageRegistry = `${app.registry.url}/${app.registry.repository}`;

  // Resolve depends_on names against the app's own services so an init
  // container dependency can be rendered with the right wait condition.
  const servicesByName = new Map(app.services.map(s => [s.name, s]));

  const lines: string[] = [];
  lines.push('services:');

  // Sort services: non-init first, then init containers
  const sortedServices = [...app.services].sort((a, b) => {
    if (a.is_init_container !== b.is_init_container) {
      return a.is_init_container ? 1 : -1;
    }
    return 0;
  });

  for (const service of sortedServices) {
    const containerName = `${app.id}-${tenantId}-${service.name}`;
    const imageName = service.image_suffix || service.name;
    const image = `${imageRegistry}/${imageName}:\${IMAGE_TAG:-${app.default_image_tag}}`;

    lines.push('');
    lines.push(`  ${service.name}:`);
    lines.push(`    image: ${image}`);
    lines.push(`    container_name: ${containerName}`);

    if (service.is_init_container) {
      lines.push('    restart: "no"');
    } else {
      lines.push('    restart: unless-stopped');
    }

    // User
    if (service.user) {
      lines.push(`    user: "${yamlEscape(service.user)}"`);
    }

    // Environment files
    lines.push('    env_file:');
    lines.push('      - .env');
    lines.push('      - shared.env');

    // Command override
    if (service.command && service.command.length > 0) {
      lines.push('    command:');
      for (const cmd of service.command) {
        lines.push(`      - "${yamlEscape(cmd)}"`);
      }
    }

    // Environment variable mapping (auto-resolved where possible)
    if (service.env_mapping && Object.keys(service.env_mapping).length > 0) {
      lines.push('    environment:');
      for (const [key, value] of Object.entries(service.env_mapping)) {
        const resolved = resolveEnvValue(value, { config, domain, service });
        lines.push(`      ${key}: "${yamlEscape(resolved)}"`);
      }
    }

    // Volumes
    const volumes: string[] = [];
    const mountedPaths = new Set<string>();
    if (service.volumes) {
      for (const vol of service.volumes) {
        const resolvedName = vol.name_template
          ? vol.name_template.replace(/\$\{appId\}/g, app.id).replace(/\$\{tenantId\}/g, tenantId)
          : vol.name;
        volumes.push(`${resolvedName}:${vol.container_path}`);
        mountedPaths.add(vol.container_path);
      }
    }
    if (service.backup?.enabled && service.backup.paths) {
      for (const p of service.backup.paths) {
        if (mountedPaths.has(p.container)) continue;
        const volName = `${service.name}-${p.local}`;
        volumes.push(`${volName}:${p.container}`);
        mountedPaths.add(p.container);
      }
    }
    if (volumes.length > 0) {
      lines.push('    volumes:');
      for (const v of volumes) {
        lines.push(`      - ${v}`);
      }
    }

    // Networks
    const serviceNetworks = service.networks || ['external'];
    lines.push('    networks:');
    if (serviceNetworks.includes('external')) {
      lines.push(`      - ${externalNetwork}`);
    }
    if (serviceNetworks.includes('internal') && needsInternalNetwork) {
      lines.push(`      - ${internalNetwork}`);
    }

    // Health check
    if (service.health_check && !service.is_init_container) {
      const hc = service.health_check;
      lines.push('    healthcheck:');
      if (hc.type === 'http') {
        const hcPath = hc.path || '/health';
        const hcPort = hc.port || service.ports?.internal || 80;
        if (hc.tool === 'curl') {
          lines.push(`      test: ["CMD", "curl", "-f", "http://127.0.0.1:${hcPort}${hcPath}"]`);
        } else {
          lines.push(`      test: ["CMD", "wget", "--spider", "-q", "http://127.0.0.1:${hcPort}${hcPath}"]`);
        }
      } else {
        const hcPort = hc.port || service.ports?.internal || 80;
        lines.push(`      test: ["CMD-SHELL", "nc -z 127.0.0.1 ${hcPort}"]`);
      }
      lines.push(`      interval: ${hc.interval || '30s'}`);
      lines.push('      timeout: 10s');
      lines.push('      retries: 3');
      if (hc.start_period) {
        lines.push(`      start_period: ${hc.start_period}`);
      }
    }

    // Depends on — always long form.
    //
    // Short-form `depends_on` ("- migrator") only controls START ORDER: it
    // never waits for the dependency to finish and never inspects its exit
    // code. For an init container that is no gating at all — a migrator that
    // died on `sh: drizzle-kit: not found` still let the backend start and
    // report healthy against a schema three migrations old.
    //
    // `service_completed_successfully` makes a non-zero init container abort
    // `docker compose up` and leave dependents unstarted. Compose rejects
    // mixing short and long form inside one block, so every dependency gets an
    // explicit condition; `service_started` is exactly what short form meant,
    // which keeps startup timing unchanged for non-init dependencies.
    if (service.depends_on && service.depends_on.length > 0) {
      lines.push('    depends_on:');
      for (const dep of service.depends_on) {
        const target = servicesByName.get(dep);
        if (!target) {
          throw new Error(
            `App '${app.id}' service '${service.name}' declares depends_on '${dep}', ` +
            `which is not a known service. Known services: ${app.services.map(s => s.name).join(', ')}.`,
          );
        }
        lines.push(`      ${dep}:`);
        lines.push(
          `        condition: ${target.is_init_container ? 'service_completed_successfully' : 'service_started'}`,
        );
      }
    }

    // Ownership labels are used by Overwatch for safe Docker discovery and
    // authorization. Keep them on every service, including non-routable workers.
    const labelLines = [
      labelLine('com.overwatch.managed', 'true'),
      labelLine('com.overwatch.app-id', app.id),
      labelLine('com.overwatch.tenant-id', tenantId),
      labelLine('com.overwatch.service', service.name),
    ];

    // Traefik labels for routable services (built via traefikLabels.ts)
    const traefikLabelLines = buildTraefikLabels({
      app,
      tenantId,
      domain,
      service,
      certResolverName,
      traefik: config.traefik,
      tenantOverrides: tenantTraefik,
    });
    labelLines.push(...traefikLabelLines);

    lines.push('    labels:');
    lines.push(...labelLines);
  }

  // Networks section
  lines.push('');
  lines.push('networks:');
  lines.push(`  ${externalNetwork}:`);
  lines.push('    external: true');
  if (needsInternalNetwork) {
    lines.push(`  ${internalNetwork}:`);
  }

  // Volumes section (if any named volumes used)
  const volumeDeclarations: Array<{ name: string; external: boolean }> = [];
  const declaredPaths = new Set<string>();
  for (const service of app.services) {
    if (service.volumes) {
      for (const vol of service.volumes) {
        const resolvedName = vol.name_template
          ? vol.name_template.replace(/\$\{appId\}/g, app.id).replace(/\$\{tenantId\}/g, tenantId)
          : vol.name;
        if (!volumeDeclarations.find(v => v.name === resolvedName)) {
          volumeDeclarations.push({ name: resolvedName, external: vol.external === true });
          if (vol.container_path) declaredPaths.add(vol.container_path);
        }
      }
    }
    if (service.backup?.enabled && service.backup.paths) {
      for (const p of service.backup.paths) {
        if (declaredPaths.has(p.container)) continue;
        const volName = `${service.name}-${p.local}`;
        if (!volumeDeclarations.find(v => v.name === volName)) {
          volumeDeclarations.push({ name: volName, external: false });
          declaredPaths.add(p.container);
        }
      }
    }
  }

  if (volumeDeclarations.length > 0) {
    lines.push('');
    lines.push('volumes:');
    for (const vol of volumeDeclarations) {
      lines.push(`  ${vol.name}:`);
      if (vol.external) {
        lines.push('    external: true');
      } else {
        lines.push(`    name: ${vol.name}`);
      }
    }
  }

  lines.push('');
  return lines.join('\n');
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
  if (typeof value === 'object' && 'static' in value) {
    return value.static;
  }
  const auto = getAutoResolvedValue(value, ctx);
  if (auto !== undefined) return auto;
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
