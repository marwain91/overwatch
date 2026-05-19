import Docker from 'dockerode';
import * as fs from 'fs/promises';
import * as path from 'path';
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

function extractContainerInfoFromKnownApps(
  containerName: string,
  apps: Array<Pick<AppDefinition, 'id' | 'services'>>,
): { appId: string; tenantId: string; service: string } | null {
  const baseName = stripReplicaSuffix(containerName);
  const sortedApps = [...apps].sort((a, b) => b.id.length - a.id.length);

  for (const app of sortedApps) {
    const prefix = `${app.id}-`;
    if (!baseName.startsWith(prefix)) continue;

    const rest = baseName.slice(prefix.length);
    const serviceNames = app.services.map(s => s.name).sort((a, b) => b.length - a.length);
    for (const service of serviceNames) {
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

export async function listContainers(): Promise<ContainerInfo[]> {
  const containers = await docker.listContainers({ all: true });
  const apps = await listApps();
  const appIds = new Set(apps.map(a => a.id));

  return containers
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
  const tenants: TenantStatus[] = [];
  const appsDir = getAppsDir();

  try {
    const apps = await listApps();

    for (const app of apps) {
      const tenantsDir = path.join(appsDir, app.id, 'tenants');
      let dirs: string[];
      try {
        dirs = await fs.readdir(tenantsDir);
      } catch {
        continue;
      }

      // Determine init and required services from app definition
      const initServices = app.services
        .filter(s => s.is_init_container)
        .map(s => s.name);
      const requiredServices = app.services
        .filter(s => s.required && !s.is_init_container)
        .map(s => s.name);

      for (const dir of dirs) {
        const tenantPath = path.join(tenantsDir, dir);
        const stat = await fs.stat(tenantPath);
        if (!stat.isDirectory()) continue;

        const envPath = path.join(tenantPath, '.env');
        try {
          const envContent = await fs.readFile(envPath, 'utf-8');
          const env = parseEnv(envContent);

          const containers = await getTenantContainers(app.id, dir);

          // Exclude init containers from counts
          const nonInitContainers = containers.filter(c => {
            return c.service ? !initServices.includes(c.service) : true;
          });

          const running = nonInitContainers.filter(c => c.state === 'running');

          // Check if all required services are running
          const healthy = requiredServices.every(serviceName =>
            running.some(c => c.service === serviceName)
          );

          tenants.push({
            appId: app.id,
            tenantId: dir,
            domain: env.TENANT_DOMAIN || 'unknown',
            version: env.IMAGE_TAG || 'unknown',
            containers,
            runningContainers: running.length,
            totalContainers: nonInitContainers.length,
            healthy,
          });
        } catch {
          // Skip if no .env file
        }
      }
    }
  } catch {
    // Apps directory doesn't exist yet
  }

  return tenants;
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

export async function ensureExternalVolumes(composePath: string): Promise<void> {
  const content = await fs.readFile(composePath, 'utf-8');
  const volumeRegex = /^  ([^\s:]+):\s*\n\s+external:\s*true/gm;
  let match;
  while ((match = volumeRegex.exec(content)) !== null) {
    const volumeName = match[1];
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
