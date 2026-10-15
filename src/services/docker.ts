import Docker from 'dockerode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { listApps } from './app';
import type { AppDefinition } from '../models/app';
import { assertTenantDir, listTenantDirs, readTenantEnv } from './tenantStore';
import { runDocker } from '../utils/runDocker';
import { withTenantLock } from './fileLock';
import { COMPOSE_LONG_TIMEOUT_MS } from './composeTimeouts';
import { generateComposeFile, readComposeNames } from './composeGenerator';
import { resolveTenantApp } from './tenantAppDef';
import { readTenantTraefik } from './tenantTraefik';
import { loadConfig } from '../config';
import { writeFileAtomic } from '../utils/atomicJson';
import { HttpError } from '../utils/httpErrors';
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
    // Docker reports `Names: []` for some leftover containers; one of those
    // must not make the whole listing throw.
    .filter(c => c.Names?.length)
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

/** Tenant .env files read at once by listTenants (every UI poll reads them all). */
const ENV_READ_CONCURRENCY = 16;

/** `fn` over `items` with at most `limit` calls in flight; results keep the input order. */
async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Tenants with their container state, for UI listings: of one app when
 * `appId` is given, else of every app. Any failure reads as "no tenants"
 * (see listTenantDirs for a listing that throws).
 */
export async function listTenants(appId?: string): Promise<TenantStatus[]> {
  try {
    const apps = await listApps();
    const scanned = appId === undefined ? apps : apps.filter(a => a.id === appId);

    // Pass 1: tenants that have a readable .env (others are skipped).
    const refs: Array<{ app: AppDefinition; dir: string }> = [];
    for (const app of scanned) {
      // An unreadable tenants dir just means this app has no tenants to report.
      for (const { tenantId } of await listTenantDirs(app.id, { onError: () => {}, followSymlinks: true })) {
        refs.push({ app, dir: tenantId });
      }
    }
    const envs = await mapWithLimit(refs, ENV_READ_CONCURRENCY,
      ({ app, dir }) => readTenantEnv(app.id, dir).catch(() => null)); // no .env: skipped
    const found = refs.flatMap((ref, i) => {
      const env = envs[i];
      return env ? [{ ...ref, env }] : [];
    });
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
  try {
    await assertTenantDir(appId, tenantId);
    const env = await readTenantEnv(appId, tenantId);

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

/**
 * Create the external volumes a tenant compose file declares, under their
 * Docker names. Compose refuses to start with a missing external volume and
 * never creates or removes one itself.
 */
export async function ensureExternalVolumes(composePath: string): Promise<void> {
  const content = await fs.readFile(composePath, 'utf-8');
  const external = readComposeNames(content).volumes.filter(v => v.external).map(v => v.name);
  for (const volumeName of external) {
    try {
      await runDocker('docker', ['volume', 'inspect', volumeName], { timeoutMs: 15_000 });
    } catch {
      await runDocker('docker', ['volume', 'create', volumeName], { timeoutMs: 30_000 });
    }
  }
}

/**
 * Regenerate a tenant's docker-compose.yml from its effective app definition,
 * its .env domain and its current Traefik overrides (host aliases, middleware
 * overrides, raw labels), keeping the volume names it already uses. Only
 * create and update used to regenerate it, so routing changes never reached a
 * running tenant. Caller must hold the tenant lock.
 *
 * Without a definition (an app in the trash whose tenant has no snapshot) or a
 * TENANT_DOMAIN there is nothing to render from: the file is kept as is. A
 * definition that cannot be rendered throws and leaves the file unchanged.
 */
export async function reconcileTenantComposeLocked(appId: string, tenantId: string): Promise<void> {
  const tenantPath = await assertTenantDir(appId, tenantId);
  const composePath = path.join(tenantPath, 'docker-compose.yml');
  let existing: string;
  try {
    existing = await fs.readFile(composePath, 'utf-8');
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
    throw new HttpError(500, `Tenant ${appId}/${tenantId} has no docker-compose.yml, so its containers cannot be managed.`, { expose: true });
  }
  let next: string;
  try {
    const app = await resolveTenantApp(appId, tenantId);
    const domain = (await readTenantEnv(appId, tenantId).catch(() => ({} as Record<string, string>))).TENANT_DOMAIN;
    if (!app || !domain) {
      console.warn(`[compose] ${appId}/${tenantId}: no ${app ? 'TENANT_DOMAIN in .env' : 'app definition'}; using its docker-compose.yml as is`);
      return;
    }
    const tenantTraefik = await readTenantTraefik(appId, tenantId);
    next = generateComposeFile({ app, tenantId, domain, config: loadConfig(), tenantTraefik, existingCompose: existing });
  } catch (err: any) {
    throw new HttpError(500, `Could not regenerate the docker-compose.yml of ${appId}/${tenantId}: ${err?.message || err}. The tenant was left as it was.`, { expose: true });
  }
  if (next !== existing) await writeFileAtomic(composePath, next);
}

export function startTenant(appId: string, tenantId: string): Promise<void> {
  return withTenantLock(appId, tenantId, () => startTenantLocked(appId, tenantId));
}

async function startTenantLocked(appId: string, tenantId: string): Promise<void> {
  const tenantPath = await assertTenantDir(appId, tenantId);
  const composePath = path.join(tenantPath, 'docker-compose.yml');
  await reconcileTenantComposeLocked(appId, tenantId);
  await ensureExternalVolumes(composePath);
  await runDocker('docker', ['compose', '--project-directory', tenantPath, '-f', composePath, 'up', '-d'], { timeoutMs: COMPOSE_LONG_TIMEOUT_MS });
}

export function stopTenant(appId: string, tenantId: string): Promise<void> {
  return withTenantLock(appId, tenantId, () => stopTenantLocked(appId, tenantId));
}

async function stopTenantLocked(appId: string, tenantId: string): Promise<void> {
  const tenantPath = await assertTenantDir(appId, tenantId);
  const composePath = path.join(tenantPath, 'docker-compose.yml');
  await runDocker('docker', ['compose', '--project-directory', tenantPath, '-f', composePath, 'down'], { timeoutMs: 120_000 });
}

export function restartTenant(appId: string, tenantId: string): Promise<void> {
  return withTenantLock(appId, tenantId, () => restartTenantLocked(appId, tenantId));
}

async function restartTenantLocked(appId: string, tenantId: string): Promise<void> {
  const tenantPath = await assertTenantDir(appId, tenantId);
  const composePath = path.join(tenantPath, 'docker-compose.yml');
  await reconcileTenantComposeLocked(appId, tenantId);
  await ensureExternalVolumes(composePath);
  await runDocker('docker', ['compose', '--project-directory', tenantPath, '-f', composePath, 'up', '-d', '--force-recreate'], { timeoutMs: COMPOSE_LONG_TIMEOUT_MS });
}
