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
    const containerName = `${prefix}-${app.id}-${tenantId}-${service.name}`;
    const imageName = service.image_suffix || service.name;
    const image = `${imageRegistry}/${imageName}:\${IMAGE_TAG:-${app.default_image_tag}}`;

    lines.push('');
    lines.push(`  ${service.name}:`);
    lines.push(`    image: ${image}`);
    lines.push(`    container_name: ${containerName}`);

    if (!service.is_init_container) {
      lines.push('    restart: unless-stopped');
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

    // Environment variable mapping
    if (service.env_mapping && Object.keys(service.env_mapping).length > 0) {
      lines.push('    environment:');
      for (const [key, value] of Object.entries(service.env_mapping)) {
        lines.push(`      ${key}: "\${${value}}"`);
      }
    }

    // Volumes
    const volumes: string[] = [];
    if (service.volumes) {
      for (const vol of service.volumes) {
        volumes.push(`${vol.name}:${vol.container_path}`);
      }
    }
    if (service.backup?.enabled && service.backup.paths) {
      for (const p of service.backup.paths) {
        // Named volume for backup paths
        const volName = `${service.name}-${p.local}`;
        volumes.push(`${volName}:${p.container}`);
      }
    }
    if (volumes.length > 0) {
      lines.push('    volumes:');
      for (const v of volumes) {
        lines.push(`      - ${v}`);
      }
    }

    // Networks
    lines.push('    networks:');
    lines.push(`      - ${externalNetwork}`);

    // Health check
    if (service.health_check && !service.is_init_container) {
      const hc = service.health_check;
      lines.push('    healthcheck:');
      if (hc.type === 'http') {
        const hcPath = hc.path || '/health';
        const hcPort = hc.port || service.ports?.internal || 80;
        lines.push(`      test: ["CMD", "wget", "--spider", "-q", "http://localhost:${hcPort}${hcPath}"]`);
      } else {
        const hcPort = hc.port || service.ports?.internal || 80;
        lines.push(`      test: ["CMD-SHELL", "nc -z localhost ${hcPort}"]`);
      }
      lines.push(`      interval: ${hc.interval || '30s'}`);
      lines.push('      timeout: 10s');
      lines.push('      retries: 3');
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

      // Host rule with optional path prefix
      let rule = `Host(\`${domain}\`)`;
      if (pathPrefix) {
        rule += ` && PathPrefix(\`${pathPrefix}\`)`;
      }
      lines.push(`      - "traefik.http.routers.${routerName}.rule=${rule}"`);
      lines.push(`      - "traefik.http.routers.${routerName}.entrypoints=websecure"`);
      lines.push(`      - "traefik.http.routers.${routerName}.tls=true"`);

      if (priority !== undefined) {
        lines.push(`      - "traefik.http.routers.${routerName}.priority=${priority}"`);
      }

      // Determine cert resolver: wildcard domains use DNS, custom domains use HTTP
      const domainTemplate = app.domain_template;
      if (domainTemplate.startsWith('*.')) {
        const baseDomain = domainTemplate.slice(2);
        lines.push(`      - "traefik.http.routers.${routerName}.tls.certresolver=letsencrypt"`);
        lines.push(`      - "traefik.http.routers.${routerName}.tls.domains[0].main=${baseDomain}"`);
        lines.push(`      - "traefik.http.routers.${routerName}.tls.domains[0].sans=*.${baseDomain}"`);
      } else {
        lines.push(`      - "traefik.http.routers.${routerName}.tls.certresolver=letsencrypt-http"`);
      }

      lines.push(`      - "traefik.http.services.${routerName}.loadbalancer.server.port=${service.ports.internal}"`);
    }
  }

  // Networks section
  lines.push('');
  lines.push('networks:');
  lines.push(`  ${externalNetwork}:`);
  lines.push('    external: true');

  // Volumes section (if any named volumes used)
  const namedVolumes: string[] = [];
  for (const service of app.services) {
    if (service.volumes) {
      for (const vol of service.volumes) {
        namedVolumes.push(vol.name);
      }
    }
    if (service.backup?.enabled && service.backup.paths) {
      for (const p of service.backup.paths) {
        namedVolumes.push(`${service.name}-${p.local}`);
      }
    }
  }

  if (namedVolumes.length > 0) {
    lines.push('');
    lines.push('volumes:');
    for (const vol of namedVolumes) {
      lines.push(`  ${vol}:`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
