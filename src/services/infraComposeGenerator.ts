import * as yaml from 'js-yaml';
import type { OverwatchConfig } from '../config/schema';
import type { Entrypoint, TraefikGlobal, TraefikOverwatch } from '../models/traefik';
import { isDenylistedLabelKey } from '../models/traefik';
import { sanitizeTraefikValue } from './traefikLabels';

/**
 * Build the infrastructure docker-compose.yml — Traefik + MariaDB.
 * Replaces the static template when `traefik.cert_resolvers` is present.
 *
 * `${PROJECT_PREFIX}` and `${NETWORK_NAME}` are left as-is so the existing
 * install-time substitution in infraTemplates.renderTemplate still works.
 */
export function buildInfraComposeYml(config: OverwatchConfig): string {
  const traefik = config.traefik;
  const hasResolvers = (traefik?.cert_resolvers?.length ?? 0) > 0;
  const upstreamMode = traefik?.tls_termination === 'upstream';
  if (!traefik || (!hasResolvers && !upstreamMode)) {
    throw new Error('buildInfraComposeYml requires traefik.cert_resolvers OR traefik.tls_termination="upstream"; use the static template for legacy installs.');
  }

  // Compose env block: per-resolver email vars, plus passthrough for any provider envs.
  // Empty when running in pure upstream-termination mode with no resolvers defined.
  const envLines: string[] = [];
  for (const r of traefik.cert_resolvers ?? []) {
    const envName = `TRAEFIK_CERTIFICATESRESOLVERS_${toEnvKey(r.name)}_ACME_EMAIL`;
    envLines.push(`${envName}=${r.acme_email}`);
    if (r.challenge === 'dns' && r.env) {
      // Pass each declared env var through from the operator's .env. The values themselves
      // come from `${KEY}` interpolation in compose, not from this generator.
      for (const key of Object.keys(r.env)) {
        envLines.push(`${key}=\${${key}}`);
      }
    }
  }

  // Preserve key order to match v1.6.9 output for existing deploys.
  // `environment` is always present (empty array under upstream-only mode);
  // js-yaml renders `environment: []` cleanly and compose ignores it.
  const traefikSvc: any = {
    image: 'traefik:v3.6',
    container_name: '${PROJECT_PREFIX}-traefik',
    restart: 'unless-stopped',
    security_opt: ['no-new-privileges:true'],
    ports: buildPortsList(traefik.entrypoints),
    environment: envLines,
    volumes: [
      '/var/run/docker.sock:/var/run/docker.sock:ro',
      './traefik/traefik.yml:/etc/traefik/traefik.yml:ro',
      './traefik/dynamic.yml:/etc/traefik/dynamic.yml:ro',
      ...(hasResolvers ? ['traefik-letsencrypt:/letsencrypt'] : []),
      'traefik-logs:/var/log/traefik',
    ],
    networks: ['shared'],
  };

  const mariadbSvc: any = {
    image: 'mariadb:10.11',
    container_name: '${PROJECT_PREFIX}-mariadb',
    restart: 'unless-stopped',
    environment: { MYSQL_ROOT_PASSWORD: '${MYSQL_ROOT_PASSWORD}' },
    volumes: [
      'mariadb-data:/var/lib/mysql',
      './mariadb/init:/docker-entrypoint-initdb.d:ro',
    ],
    networks: ['shared'],
    healthcheck: {
      test: ['CMD', 'healthcheck.sh', '--connect', '--innodb_initialized'],
      interval: '10s',
      timeout: '5s',
      retries: 5,
    },
  };

  // Preserve key order to match v1.6.9 output for existing deploys (with
  // cert_resolvers). For upstream-only deploys the letsencrypt volume is
  // omitted entirely.
  const volumes: any = {};
  if (hasResolvers) {
    volumes['traefik-letsencrypt'] = null;
  }
  volumes['traefik-logs'] = null;
  volumes['mariadb-data'] = null;

  const out: any = {
    services: { traefik: traefikSvc, mariadb: mariadbSvc },
    networks: { shared: { name: '${NETWORK_NAME}', external: true } },
    volumes,
  };

  return banner('Shared infrastructure stack — Traefik + MariaDB. Generated from overwatch.yaml.') +
    yaml.dump(out, { lineWidth: 120, noRefs: true, quotingType: '"' });
}

/**
 * Build the compose `ports:` list for Traefik.
 *
 * - If `entrypoints` is defined, emit one mapping per entrypoint, honoring
 *   `host_bind` (default omit) and `host_port` (default = `port`).
 * - Otherwise, fall back to the legacy `80:80` + `443:443` for backward compat.
 */
function buildPortsList(entrypoints: Entrypoint[] | undefined): string[] {
  if (!entrypoints || entrypoints.length === 0) {
    return ['80:80', '443:443'];
  }
  return entrypoints.map((e) => {
    const hostPort = e.host_port ?? e.port;
    return e.host_bind
      ? `${e.host_bind}:${hostPort}:${e.port}`
      : `${hostPort}:${e.port}`;
  });
}

/**
 * Build the Overwatch admin docker-compose.yml using the `traefik.overwatch`
 * config to drive the router labels. Falls back to env-var labels when
 * `traefik.overwatch` is absent.
 */
export function buildOverwatchComposeYml(config: OverwatchConfig): string {
  const ow = config.traefik?.overwatch;
  const labels = ow ? buildOverwatchLabels(ow, config.traefik!) : legacyOverwatchLabels(config.traefik);

  const overwatchSvc: any = {
    image: 'ghcr.io/marwain91/overwatch:latest',
    container_name: '${PROJECT_PREFIX}-overwatch',
    restart: 'unless-stopped',
    environment: {
      OVERWATCH_UID: '"${OVERWATCH_UID:-1001}"',
      OVERWATCH_GID: '"${OVERWATCH_GID:-1001}"',
      PORT: 3002,
      MYSQL_ROOT_PASSWORD: '${MYSQL_ROOT_PASSWORD}',
      GOOGLE_CLIENT_ID: '${GOOGLE_CLIENT_ID}',
      JWT_SECRET: '${JWT_SECRET}',
      GHCR_TOKEN: '${GHCR_TOKEN}',
      AUTH_SERVICE_SECRET: '${AUTH_SERVICE_SECRET}',
      RESTIC_PASSWORD: '${RESTIC_PASSWORD}',
      R2_ACCOUNT_ID: '${R2_ACCOUNT_ID}',
      R2_ACCESS_KEY_ID: '${R2_ACCESS_KEY_ID}',
      R2_SECRET_ACCESS_KEY: '${R2_SECRET_ACCESS_KEY}',
      R2_BUCKET_NAME: '${R2_BUCKET_NAME}',
      R2_ENDPOINT: 'https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
    },
    volumes: [
      '/var/run/docker.sock:/var/run/docker.sock',
      '/root/.docker:/root/.docker:ro',
      // Mounted RW so the admin UI / REST API can persist edits (Traefik
      // config, etc.). Host file permissions still gate writes.
      './overwatch.yaml:/app/overwatch.yaml',
      './data:/app/data',
      '${APPS_PATH_ON_HOST}:/app/apps',
    ],
    networks: ['shared'],
    labels,
    healthcheck: {
      test: ['CMD', 'wget', '--no-verbose', '--tries=1', '--spider', 'http://localhost:3002/health'],
      interval: '30s',
      timeout: '10s',
      retries: 3,
      start_period: '10s',
    },
    deploy: { resources: { limits: { memory: '512M', cpus: '"1.0"' } } },
  };

  const out: any = {
    services: { overwatch: overwatchSvc },
    networks: { shared: { name: '${NETWORK_NAME}', external: true } },
  };

  return banner('Overwatch admin container. Generated from overwatch.yaml.traefik.overwatch.') +
    yaml.dump(out, { lineWidth: 120, noRefs: true, quotingType: '"' });
}

function buildOverwatchLabels(ow: TraefikOverwatch, traefik: TraefikGlobal): string[] {
  const upstream = traefik.tls_termination === 'upstream';
  const entrypoint = upstream ? (traefik.upstream_entrypoint ?? 'web') : 'websecure';
  const out: string[] = [];
  out.push('traefik.enable=true');
  const safeHost = sanitizeTraefikValue(ow.host);
  out.push(`traefik.http.routers.admin.rule=Host(\`${safeHost}\`)`);
  out.push(`traefik.http.routers.admin.entrypoints=${entrypoint}`);
  if (!upstream) {
    out.push('traefik.http.routers.admin.tls=true');
    if (ow.cert_resolver) {
      out.push(`traefik.http.routers.admin.tls.certresolver=${sanitizeTraefikValue(ow.cert_resolver)}`);
    }
  }

  const mws: string[] = ow.middlewares ?? [];
  if (mws.length > 0) {
    // Reference middlewares from the file provider (defined in dynamic.yml)
    out.push(`traefik.http.routers.admin.middlewares=${mws.map((m: string) => `${m}@file`).join(',')}`);
  }
  out.push('traefik.http.services.admin.loadbalancer.server.port=3002');

  for (const [k, v] of Object.entries(ow.raw_labels ?? {})) {
    if (isDenylistedLabelKey(k)) continue;
    out.push(`${k}=${v}`);
  }
  return out;
}

function legacyOverwatchLabels(traefik?: TraefikGlobal): string[] {
  const upstream = traefik?.tls_termination === 'upstream';
  const entrypoint = upstream ? (traefik?.upstream_entrypoint ?? 'web') : 'websecure';
  const labels = [
    'traefik.enable=true',
    'traefik.http.routers.admin.rule=Host(`${OVERWATCH_ADMIN_HOST}`)',
    `traefik.http.routers.admin.entrypoints=${entrypoint}`,
  ];
  if (!upstream) {
    labels.push('traefik.http.routers.admin.tls=true');
    labels.push('traefik.http.routers.admin.tls.certresolver=${OVERWATCH_ADMIN_CERT_RESOLVER:-letsencrypt}');
  }
  labels.push('traefik.http.services.admin.loadbalancer.server.port=3002');
  return labels;
}

function toEnvKey(name: string): string {
  return name.replace(/-/g, '_').toUpperCase();
}

function banner(comment: string): string {
  return `# ${comment.replace(/\n/g, '\n# ')}\n# Edits will be overwritten by \`overwatch infra deploy\`.\n\n`;
}
