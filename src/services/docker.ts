import Docker from 'dockerode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { loadConfig, getAppsDir } from '../config';
import { listApps } from './app';
import type { AppDefinition } from '../models/app';
import { assertWithinDir } from '../utils/security';
import { parseEnv } from '../utils/env';
import { runDocker } from '../utils/runDocker';
const docker = new Docker({ socketPath: '/var/run/docker.sock' });
export { docker };

export interface ContainerInfo {
  id: string;
  name: string;
  status: string;
  state: string;
  image: string;
  created: string;
  appId?: string;
  tenantId?: string;
  service?: string;
}

export interface TenantStatus {
  appId: string;
  tenantId: string;
  domain: string;
  version: string;
  containers: ContainerInfo[];
  runningContainers: number;
  totalContainers: number;
  healthy: boolean;
}

const LABEL_MANAGED = 'com.overwatch.managed';
const LABEL_APP_ID = 'com.overwatch.app-id';
const LABEL_TENANT_ID = 'com.overwatch.tenant-id';
const LABEL_SERVICE = 'com.overwatch.service';

type ContainerLabels = Record<string, string | undefined>;

function normaliseLabels(labels: unknown): ContainerLabels {
  if (!labels || typeof labels !== 'object') return {};
  return labels as ContainerLabels;
}

function stripReplicaSuffix(containerName: string): string {
  const parts = containerName.split('-');
  if (parts.length > 3 && /^\d+$/.test(parts[parts.length - 1])) {
    return parts.slice(0, -1).join('-');
  }
  return containerName;
}

function extractContainerInfoFromLabels(labels: ContainerLabels): { appId: string; tenantId: string; service: string } | null {
  if (labels[LABEL_MANAGED] !== 'true') return null;
  const appId = labels[LABEL_APP_ID];
  const tenantId = labels[LABEL_TENANT_ID];
  const service = labels[LABEL_SERVICE] || labels['com.docker.compose.service'];
  if (!appId || !tenantId || !service) return null;
  return { appId, tenantId, service };
}

type KnownApp = Pick<AppDefinition, 'id' | 'services'>;
interface PreparedApp { id: string; serviceNames: string[] }

// Callers pass the same apps array for every container of a pass; sort once per array.
const preparedApps = new WeakMap<object, PreparedApp[]>();

function prepareKnownApps(apps: KnownApp[]): PreparedApp[] {
  let prepared = preparedApps.get(apps);
  if (!prepared) {
    prepared = [...apps]
      .sort((a, b) => b.id.length - a.id.length)
      .map(app => ({ id: app.id, serviceNames: app.services.map(s => s.name).sort((a, b) => b.length - a.length) }));
    preparedApps.set(apps, prepared);
  }
  return prepared;
}

function extractContainerInfoFromKnownApps(
  containerName: string,
  apps: KnownApp[],
): { appId: string; tenantId: string; service: string } | null {
  const baseName = stripReplicaSuffix(containerName);

  for (const app of prepareKnownApps(apps)) {
    const prefix = `${app.id}-`;
    if (!baseName.startsWith(prefix)) continue;

    const rest = baseName.slice(prefix.length);
    for (const service of app.serviceNames) {
      const suffix = `-${service}`;
      if (!rest.endsWith(suffix)) continue;

      const tenantId = rest.slice(0, -suffix.length);
      if (tenantId.length === 0) continue;
      return { appId: app.id, tenantId, service };
    }
  }

  return null;
}

/**
 * Name pattern for containers managed by Overwatch:
 * {appId}-{tenantId}-{service}(-N)?
 */
export function getManagedContainerNamePattern(appIds: string[]): RegExp {
  const escaped = appIds.map(id => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^/?(${escaped.join('|')})-[a-z0-9-]+-[a-z0-9-]+(?:-\\d+)?$`);
}

/**
 * Extract appId, tenantId, and service from a container name.
 * Pattern: {appId}-{tenantId}-{service}(-N)?
 */
export function extractContainerInfo(
  containerName: string,
  labels: ContainerLabels = {},
  knownApps?: Array<Pick<AppDefinition, 'id' | 'services'>>,
): { appId: string; tenantId: string; service: string } | null {
  const labelInfo = extractContainerInfoFromLabels(labels);
  if (labelInfo) return labelInfo;

  if (knownApps) {
    const knownInfo = extractContainerInfoFromKnownApps(containerName, knownApps);
    if (knownInfo) return knownInfo;
  }

  const parts = containerName.split('-');
  if (parts.length < 3) return null;

  // Strip trailing replica number if present
  let serviceParts = [...parts];
  if (/^\d+$/.test(serviceParts[serviceParts.length - 1]) && serviceParts.length > 3) {
    serviceParts.pop();
  }

  // The service name is the last part
  const service = serviceParts[serviceParts.length - 1];
  const remaining = serviceParts.slice(0, -1);

  // Split remaining into appId and tenantId
  // Heuristic: first segment is appId, rest is tenantId
  if (remaining.length >= 2) {
    return {
      appId: remaining[0],
      tenantId: remaining.slice(1).join('-'),
      service,
    };
  }

  return null;
}

type RawContainer = Awaited<ReturnType<typeof docker.listContainers>>[number];

function toManagedContainers(raw: RawContainer[], apps: AppDefinition[]): ContainerInfo[] {
  const appIds = new Set(apps.map(a => a.id));

  return raw
    .map(c => {
      const name = c.Names[0].replace(/^\//, '');
      const labels = normaliseLabels((c as any).Labels);
      const info = extractContainerInfo(name, labels, apps);
      return {
        id: c.Id.substring(0, 12),
        name,
        status: c.Status,
        state: c.State,
        image: c.Image,
        created: new Date(c.Created * 1000).toISOString(),
        appId: info?.appId,
        tenantId: info?.tenantId,
        service: info?.service,
      };
    })
    .filter(c => c.appId !== undefined && appIds.has(c.appId));
}

/** Managed containers. Pass `apps` when the caller already read them. */
export async function listContainers(apps?: AppDefinition[]): Promise<ContainerInfo[]> {
  const [containers, knownApps] = await Promise.all([
    docker.listContainers({ all: true }),
    apps ?? listApps(),
  ]);
  return toManagedContainers(containers, knownApps);
}

/**
 * Look one container up by id (or id prefix) without listing them all, and
 * apply the same managed-container rules as listContainers. Ambiguous or
 * unmanaged ids resolve to null (fail closed).
 */
export async function findManagedContainer(idOrPrefix: string): Promise<ContainerInfo | null> {
  const [raw, apps] = await Promise.all([
    docker.listContainers({ all: true, filters: { id: [idOrPrefix] } }),
    listApps(),
  ]);
  const matches = toManagedContainers(raw, apps);
  return raw.length === 1 && matches.length === 1 ? matches[0] : null;
}

export async function getTenantContainers(appId: string, tenantId: string): Promise<ContainerInfo[]> {
  const containers = await listContainers();
  return containers.filter(c => c.appId === appId && c.tenantId === tenantId);
}

export async function getContainerLogs(containerId: string, tail: number = 100): Promise<string> {
  const container = docker.getContainer(containerId);
  const logs = await container.logs({
    stdout: true,
    stderr: true,
    tail,
    timestamps: true,
  });

  return logs.toString('utf-8');
}

export async function restartContainer(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  await container.restart();
}

export async function listTenants(): Promise<TenantStatus[]> {
  const appsDir = getAppsDir();

  try {
    const apps = await listApps();

    // Pass 1: tenants that have a readable .env (others are skipped).
    const found: Array<{ app: AppDefinition; dir: string; env: Record<string, string> }> = [];
    for (const app of apps) {
      const tenantsDir = path.join(appsDir, app.id, 'tenants');
      let dirs: string[];
      try {
        dirs = await fs.readdir(tenantsDir);
      } catch {
        continue;
      }

      for (const dir of dirs) {
        const tenantPath = path.join(tenantsDir, dir);
        try {
          if (!(await fs.stat(tenantPath)).isDirectory()) continue;
          const envContent = await fs.readFile(path.join(tenantPath, '.env'), 'utf-8');
          found.push({ app, dir, env: parseEnv(envContent) });
        } catch {
          // Skip if no .env file
        }
      }
    }
    if (found.length === 0) return [];

    // One Docker call for all tenants, grouped by app and tenant.
    const byTenant = new Map<string, ContainerInfo[]>();
    for (const c of toManagedContainers(await docker.listContainers({ all: true }), apps)) {
      const key = `${c.appId}:${c.tenantId}`;
      const list = byTenant.get(key);
      if (list) list.push(c); else byTenant.set(key, [c]);
    }

    return found.map(({ app, dir, env }) => {
      const initServices = new Set(app.services.filter(s => s.is_init_container).map(s => s.name));
      const requiredServices = app.services
        .filter(s => s.required && !s.is_init_container)
        .map(s => s.name);
      const containers = byTenant.get(`${app.id}:${dir}`) ?? [];

      // Exclude init containers from counts
      const nonInitContainers = containers.filter(c => (c.service ? !initServices.has(c.service) : true));
      const running = nonInitContainers.filter(c => c.state === 'running');

      return {
        appId: app.id,
        tenantId: dir,
        domain: env.TENANT_DOMAIN || 'unknown',
        version: env.IMAGE_TAG || 'unknown',
        containers,
        runningContainers: running.length,
        totalContainers: nonInitContainers.length,
        healthy: requiredServices.every(name => running.some(c => c.service === name)),
      };
    });
  } catch {
    // Apps directory doesn't exist yet, or Docker is unreachable: no tenants to report
    return [];
  }
}

export async function getTenantInfo(appId: string, tenantId: string): Promise<{ appId: string; tenantId: string; domain: string; version: string } | null> {
  const appsDir = getAppsDir();
  const tenantPath = path.join(appsDir, appId, 'tenants', tenantId);
  const envPath = path.join(tenantPath, '.env');

  try {
    await assertWithinDir(tenantPath, appsDir);
    const envContent = await fs.readFile(envPath, 'utf-8');
    const env = parseEnv(envContent);

    return {
      appId,
      tenantId,
      domain: env.TENANT_DOMAIN || 'unknown',
      version: env.IMAGE_TAG || 'unknown',
    };
  } catch {
    return null;
  }
}

/** Names of the top-level volumes a compose file declares `external: true`. */
function externalVolumeNames(composeText: string): string[] {
  const doc = yaml.load(composeText) as { volumes?: Record<string, { external?: unknown } | null> } | null;
  const volumes = doc && typeof doc === 'object' ? doc.volumes : undefined;
  if (!volumes || typeof volumes !== 'object') return [];
  return Object.entries(volumes)
    .filter(([, def]) => def && typeof def === 'object' && def.external === true)
    .map(([name]) => name);
}

export async function ensureExternalVolumes(composePath: string): Promise<void> {
  const content = await fs.readFile(composePath, 'utf-8');
  for (const volumeName of externalVolumeNames(content)) {
    try {
      await runDocker('docker', ['volume', 'inspect', volumeName], { timeoutMs: 15_000 });
    } catch {
      await runDocker('docker', ['volume', 'create', volumeName], { timeoutMs: 30_000 });
    }
  }
}

export async function startTenant(appId: string, tenantId: string): Promise<void> {
  const appsDir = getAppsDir();
  const tenantPath = path.join(appsDir, appId, 'tenants', tenantId);
  await assertWithinDir(tenantPath, appsDir);
  const composePath = path.join(tenantPath, 'docker-compose.yml');
  await ensureExternalVolumes(composePath);
  await runDocker('docker', ['compose', '--project-directory', tenantPath, '-f', composePath, 'up', '-d'], { timeoutMs: 300_000 });
}

export async function stopTenant(appId: string, tenantId: string): Promise<void> {
  const appsDir = getAppsDir();
  const tenantPath = path.join(appsDir, appId, 'tenants', tenantId);
  await assertWithinDir(tenantPath, appsDir);
  const composePath = path.join(tenantPath, 'docker-compose.yml');
  await runDocker('docker', ['compose', '--project-directory', tenantPath, '-f', composePath, 'down'], { timeoutMs: 120_000 });
}

export async function restartTenant(appId: string, tenantId: string): Promise<void> {
  const appsDir = getAppsDir();
  const tenantPath = path.join(appsDir, appId, 'tenants', tenantId);
  await assertWithinDir(tenantPath, appsDir);
  const composePath = path.join(tenantPath, 'docker-compose.yml');
  await ensureExternalVolumes(composePath);
  await runDocker('docker', ['compose', '--project-directory', tenantPath, '-f', composePath, 'up', '-d', '--force-recreate'], { timeoutMs: 300_000 });
}
