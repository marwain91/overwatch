import Docker from 'dockerode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { loadConfig, getContainerPrefix, getAppsDir } from '../config';
import { listApps } from './app';

const execAsync = promisify(exec);
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

/**
 * Build regex pattern for matching all managed containers.
 * Pattern: {prefix}-{appId}-{tenantId}-{service}(-N)?
 */
function getContainerPattern(): RegExp {
  const prefix = getContainerPrefix();
  return new RegExp(`^${prefix}-[a-z0-9-]+-[a-z0-9-]+-[a-z0-9-]+(?:-\\d+)?$`);
}

/**
 * Build regex pattern for matching containers of a specific app+tenant
 */
function getTenantContainerPattern(appId: string, tenantId: string): RegExp {
  const prefix = getContainerPrefix();
  const escapedApp = appId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedId = tenantId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${prefix}-${escapedApp}-${escapedId}-[a-z0-9-]+(?:-\\d+)?$`);
}

/**
 * Extract appId, tenantId, and service from a container name.
 * Pattern: {prefix}-{appId}-{tenantId}-{service}(-N)?
 */
export function extractContainerInfo(containerName: string): { appId: string; tenantId: string; service: string } | null {
  const prefix = getContainerPrefix();
  if (!containerName.startsWith(`${prefix}-`)) return null;

  const withoutPrefix = containerName.slice(prefix.length + 1);
  // We need to match: {appId}-{tenantId}-{service}(-N)?
  // Split on '-' and try to match known apps
  const parts = withoutPrefix.split('-');
  if (parts.length < 3) return null;

  // Strip trailing replica number if present
  let serviceParts = [...parts];
  if (/^\d+$/.test(serviceParts[serviceParts.length - 1]) && serviceParts.length > 3) {
    serviceParts.pop();
  }

  // The service name is the last part
  const service = serviceParts[serviceParts.length - 1];
  const remaining = serviceParts.slice(0, -1);

  // Split remaining into appId and tenantId — try all split points
  // Heuristic: try the first part as appId, rest as tenantId
  if (remaining.length >= 2) {
    // Simple case: appId is single segment, tenantId is everything else
    // For multi-segment IDs we need the app list
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
  const pattern = getContainerPattern();
  const prefix = getContainerPrefix();

  return containers
    .filter(c => c.Names.some(n => {
      const name = n.replace(/^\//, '');
      return name.startsWith(`${prefix}-`) && pattern.test(name);
    }))
    .map(c => {
      const name = c.Names[0].replace(/^\//, '');
      const info = extractContainerInfo(name);
      return {
        id: c.Id.substring(0, 12),
        name,
        status: c.Status,
        state: c.State,
        image: c.Image,
        created: new Date(c.Created * 1000).toISOString(),
        appId: info?.appId,
      };
    });
}

export async function getTenantContainers(appId: string, tenantId: string): Promise<ContainerInfo[]> {
  const containers = await listContainers();
  const pattern = getTenantContainerPattern(appId, tenantId);
  return containers.filter(c => pattern.test(c.name));
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
  const prefix = getContainerPrefix();

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
            const info = extractContainerInfo(c.name);
            return info ? !initServices.includes(info.service) : true;
          });

          const running = nonInitContainers.filter(c => c.state === 'running');

          // Check if all required services are running
          const healthy = requiredServices.every(serviceName =>
            running.some(c => c.name.includes(`-${serviceName}`))
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
  const tenantPath = path.join(getAppsDir(), appId, 'tenants', tenantId);
  const envPath = path.join(tenantPath, '.env');

  try {
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

export async function startTenant(appId: string, tenantId: string): Promise<void> {
  const tenantPath = path.join(getAppsDir(), appId, 'tenants', tenantId);
  await execAsync(`docker compose -f ${tenantPath}/docker-compose.yml up -d`);
}

export async function stopTenant(appId: string, tenantId: string): Promise<void> {
  const tenantPath = path.join(getAppsDir(), appId, 'tenants', tenantId);
  await execAsync(`docker compose -f ${tenantPath}/docker-compose.yml down`);
}

export async function restartTenant(appId: string, tenantId: string): Promise<void> {
  const tenantPath = path.join(getAppsDir(), appId, 'tenants', tenantId);
  await execAsync(`docker compose -f ${tenantPath}/docker-compose.yml up -d --force-recreate`);
}

function parseEnv(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const [key, ...valueParts] = trimmed.split('=');
    if (key && valueParts.length > 0) {
      env[key] = valueParts.join('=');
    }
  }

  return env;
}
