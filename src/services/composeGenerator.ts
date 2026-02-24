import { AppDefinition, AppService } from '../models/app';
import { OverwatchConfig } from '../config/schema';

interface GenerateOptions {
  app: AppDefinition;
  tenantId: string;
  domain: string;
  config: OverwatchConfig;
}

/**
 * Generate a docker-compose.yml content from app service definitions.
 * Produces YAML as a string (no external YAML library dependency needed).
 */
export function generateComposeFile(options: GenerateOptions): string {
  const { app, tenantId, domain, config } = options;
  const prefix = config.project.prefix;
  const externalNetwork = config.networking?.external_network || `${prefix}-network`;
  const internalNetworkTemplate = config.networking?.internal_network_template || `${prefix}-\${tenantId}-internal`;
  const internalNetwork = internalNetworkTemplate
    .replace(/\$\{prefix\}/g, prefix)
    .replace(/\$\{tenantId\}/g, tenantId);
  const needsInternalNetwork = app.services.some(s => s.networks?.includes('internal'));
  const imageRegistry = `${app.registry.url}/${app.registry.repository}`;

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
      lines.push(`    user: "${service.user}"`);
    }

    // Environment files
    lines.push('    env_file:');
    lines.push('      - .env');
    lines.push('      - shared.env');

    // Command override
    if (service.command && service.command.length > 0) {
      lines.push('    command:');
      for (const cmd of service.command) {
        lines.push(`      - "${cmd}"`);
      }
    }

    // Environment variable mapping (auto-resolved where possible)
    if (service.env_mapping && Object.keys(service.env_mapping).length > 0) {
      lines.push('    environment:');
      for (const [key, value] of Object.entries(service.env_mapping)) {
        const resolved = resolveEnvValue(value, { config, domain, service });
        lines.push(`      ${key}: "${resolved}"`);
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

    // Depends on
    if (service.depends_on && service.depends_on.length > 0) {
      lines.push('    depends_on:');
      for (const dep of service.depends_on) {
        lines.push(`      - ${dep}`);
      }
    }

    // Traefik labels for routable services
    if (!service.is_init_container && service.ports?.internal && service.routing?.enabled !== false) {
      const routerName = `${app.id}-${tenantId}-${service.name}`;
      const pathPrefix = service.routing?.path_prefix;
      const priority = service.routing?.priority;

      lines.push('    labels:');
      lines.push('      - "traefik.enable=true"');

      // Host rule with optional path prefix(es)
      let rule = `Host(\`${domain}\`)`;
      const additionalPrefixes = service.routing?.additional_path_prefixes;
      if (pathPrefix && additionalPrefixes && additionalPrefixes.length > 0) {
        const allPrefixes = [pathPrefix, ...additionalPrefixes];
        rule += ` && (${allPrefixes.map(p => `PathPrefix(\`${p}\`)`).join(' || ')})`;
      } else if (pathPrefix) {
        rule += ` && PathPrefix(\`${pathPrefix}\`)`;
      }
      lines.push(`      - "traefik.http.routers.${routerName}.rule=${rule}"`);
      lines.push(`      - "traefik.http.routers.${routerName}.entrypoints=websecure"`);
      lines.push(`      - "traefik.http.routers.${routerName}.tls=true"`);

      if (priority !== undefined) {
        lines.push(`      - "traefik.http.routers.${routerName}.priority=${priority}"`);
      }

      // Cert resolver: use env var set per-tenant based on domain matching
      lines.push(`      - "traefik.http.routers.${routerName}.tls.certresolver=\${CERT_RESOLVER}"`);

      // StripPrefix middleware
      if (pathPrefix && service.routing?.strip_prefix) {
        const allPrefixes = additionalPrefixes && additionalPrefixes.length > 0
          ? [pathPrefix, ...additionalPrefixes].join(',')
          : pathPrefix;
        lines.push(`      - "traefik.http.middlewares.${routerName}-strip.stripprefix.prefixes=${allPrefixes}"`);
        lines.push(`      - "traefik.http.routers.${routerName}.middlewares=${routerName}-strip"`);
      }

      lines.push(`      - "traefik.http.services.${routerName}.loadbalancer.server.port=${service.ports.internal}"`);
    }
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
      if (vol.external) {
        lines.push(`  ${vol.name}:`);
        lines.push('    external: true');
      } else {
        lines.push(`  ${vol.name}:`);
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
