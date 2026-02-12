import Docker from 'dockerode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { loadConfig, getContainerPrefix, getServiceNames, getRequiredServices, getTenantsDir } from '../config';

const execAsync = promisify(exec);
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

export interface ContainerInfo {
  id: string;
  name: string;
  status: string;
  state: string;
  image: string;
  created: string;
}

export interface TenantStatus {
  tenantId: string;
  domain: string;
  version: string;
  containers: ContainerInfo[];
  runningContainers: number;
  totalContainers: number;
  healthy: boolean;
}

/**
 * Build regex pattern for matching containers
 */
function getContainerPattern(): RegExp {
  const prefix = getContainerPrefix();
  const serviceNames = getServiceNames().join('|');
  return new RegExp(`^${prefix}-[a-z0-9-]+-(?:${serviceNames})(?:-\\d+)?$`);
}

/**
 * Build regex pattern for matching containers of a specific tenant
 */
function getTenantContainerPattern(tenantId: string): RegExp {
  const prefix = getContainerPrefix();
  const serviceNames = getServiceNames().join('|');
  const escapedId = tenantId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${prefix}-${escapedId}-(${serviceNames})(-\\d+)?$`);
}

/**
 * Get init container service names (excluded from health counts)
 */
function getInitContainerServices(): string[] {
  const config = loadConfig();
  return config.services
    .filter(s => s.is_init_container)
    .map(s => s.name);
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
    .map(c => ({
      id: c.Id.substring(0, 12),
      name: c.Names[0].replace(/^\//, ''),
      status: c.Status,
      state: c.State,
      image: c.Image,
      created: new Date(c.Created * 1000).toISOString(),
    }));
}

export async function getTenantContainers(tenantId: string): Promise<ContainerInfo[]> {
  const containers = await listContainers();
  const pattern = getTenantContainerPattern(tenantId);
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
  const tenantsDir = getTenantsDir();
  const initServices = getInitContainerServices();
  const requiredServices = getRequiredServices();
  const prefix = getContainerPrefix();

  try {
    const dirs = await fs.readdir(tenantsDir);

    for (const dir of dirs) {
      const tenantPath = path.join(tenantsDir, dir);
      const stat = await fs.stat(tenantPath);

      if (!stat.isDirectory()) continue;

      const envPath = path.join(tenantPath, '.env');
      try {
        const envContent = await fs.readFile(envPath, 'utf-8');
        const env = parseEnv(envContent);

        const containers = await getTenantContainers(dir);

        // Exclude init containers from counts
        const nonInitContainers = containers.filter(c => {
          const serviceName = extractServiceName(c.name, prefix);
          return !initServices.includes(serviceName);
        });

        const running = nonInitContainers.filter(c => c.state === 'running');

        // Check if all required services are running
        const healthy = requiredServices.every(serviceName =>
          running.some(c => c.name.includes(`-${serviceName}`))
        );

        tenants.push({
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
  } catch {
    // Tenants directory doesn't exist yet
  }

  return tenants;
}

export async function getTenantInfo(tenantId: string): Promise<{ tenantId: string; domain: string; version: string } | null> {
  const tenantPath = path.join(getTenantsDir(), tenantId);
  const envPath = path.join(tenantPath, '.env');

  try {
    const envContent = await fs.readFile(envPath, 'utf-8');
    const env = parseEnv(envContent);

    return {
      tenantId,
      domain: env.TENANT_DOMAIN || 'unknown',
      version: env.IMAGE_TAG || 'unknown',
    };
  } catch {
    return null;
  }
}

export async function startTenant(tenantId: string): Promise<void> {
  const tenantPath = path.join(getTenantsDir(), tenantId);
  await execAsync(`docker compose -f ${tenantPath}/docker-compose.yml up -d`);
}

export async function stopTenant(tenantId: string): Promise<void> {
  const tenantPath = path.join(getTenantsDir(), tenantId);
  await execAsync(`docker compose -f ${tenantPath}/docker-compose.yml down`);
}

export async function restartTenant(tenantId: string): Promise<void> {
  const tenantPath = path.join(getTenantsDir(), tenantId);
  await execAsync(`docker compose -f ${tenantPath}/docker-compose.yml up -d --force-recreate`);
}

/**
 * Extract service name from container name
 */
function extractServiceName(containerName: string, prefix: string): string {
  // Pattern: {prefix}-{tenantId}-{service}(-N)?
  const pattern = new RegExp(`^${prefix}-[^-]+-(.+?)(?:-\\d+)?$`);
  const match = containerName.match(pattern);
  return match ? match[1] : '';
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
