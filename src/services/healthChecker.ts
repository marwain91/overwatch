import http from 'http';
import net from 'net';
import cron, { ScheduledTask } from 'node-cron';
import { docker, extractContainerInfo } from './docker';
import { eventBus } from './eventBus';
import { listApps } from './app';
import { AppService } from '../models/app';

interface HealthState {
  containerName: string;
  appId: string;
  tenantId: string;
  service: string;
  state: 'healthy' | 'unhealthy' | 'unknown';
  consecutiveFailures: number;
  lastCheck: string | null;
}

const healthStates = new Map<string, HealthState>();
let scheduledTask: ScheduledTask | null = null;
let checking = false;

function getContainerPattern(appIds: string[]): RegExp {
  const escaped = appIds.map(id => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^/?(${escaped.join('|')})-[a-z0-9-]+-[a-z0-9-]+(?:-\\d+)?$`);
}

function parseInterval(interval: string): number {
  const match = interval.match(/^(\d+)([smh]?)$/);
  if (!match) return 30;
  const value = parseInt(match[1], 10);
  const unit = match[2] || 's';
  switch (unit) {
    case 'm': return value * 60;
    case 'h': return value * 3600;
    default: return value;
  }
}

async function checkHTTP(host: string, port: number, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: host, port, path, timeout: 5000 },
      (res) => {
        res.resume();
        resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 400);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function checkTCP(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: 5000 }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function runHealthChecks(): Promise<void> {
  if (checking) return;
  checking = true;

  try {
    const apps = await listApps();
    const pattern = getContainerPattern(apps.map(a => a.id));

    // Build service config map keyed by appId -> serviceName -> config
    const serviceMap = new Map<string, Map<string, AppService>>();
    for (const app of apps) {
      const svcMap = new Map<string, AppService>();
      for (const svc of app.services) {
        svcMap.set(svc.name, svc);
      }
      serviceMap.set(app.id, svcMap);
    }

    // Get running containers
    const containers = await docker.listContainers({ filters: { status: ['running'] } });
    const managedContainers = containers.filter(c =>
      c.Names.some(n => pattern.test(n))
    );

    for (const container of managedContainers) {
      const name = container.Names[0].replace(/^\//, '');
      const info = extractContainerInfo(name);
      if (!info) continue;

      const { appId, tenantId, service: serviceName } = info;
      const appServices = serviceMap.get(appId);
      if (!appServices) continue;

      const svcConfig = appServices.get(serviceName);
      if (!svcConfig?.health_check) continue;

      const hc = svcConfig.health_check;
      const port = hc.port || svcConfig.ports?.internal;
      if (!port) continue;

      const host = name; // Docker DNS resolution

      let isHealthy: boolean;
      if (hc.type === 'tcp') {
        isHealthy = await checkTCP(host, port);
      } else {
        const hcPath = hc.path || '/';
        isHealthy = await checkHTTP(host, port, hcPath);
      }

      const currentState = healthStates.get(name);
      const previousState = currentState?.state || 'unknown';
      const consecutiveFailures = isHealthy ? 0 : (currentState?.consecutiveFailures || 0) + 1;
      const newState: HealthState['state'] = isHealthy ? 'healthy' : 'unhealthy';

      healthStates.set(name, {
        containerName: name,
        appId,
        tenantId,
        service: serviceName,
        state: newState,
        consecutiveFailures,
        lastCheck: new Date().toISOString(),
      });

      // Emit state transition
      if (previousState !== newState) {
        eventBus.emit('health:change', {
          containerName: name,
          appId,
          tenantId,
          service: serviceName,
          previousState,
          newState,
          consecutiveFailures,
          lastCheck: new Date().toISOString(),
        });
      }
    }
  } catch (error: any) {
    console.error('[HealthChecker] Error:', error.message);
  } finally {
    checking = false;
  }
}

export function startHealthChecker(): void {
  // Use a default interval; per-app intervals are evaluated during checks
  const minInterval = 10;
  const cronExpr = `*/${minInterval} * * * * *`;

  if (!cron.validate(cronExpr)) {
    console.error(`[HealthChecker] Invalid cron expression: ${cronExpr}`);
    return;
  }

  scheduledTask = cron.schedule(cronExpr, runHealthChecks, {
    name: 'health-checker',
    noOverlap: true,
  });

  console.log(`[HealthChecker] Started (interval: ${minInterval}s)`);

  // Run immediately
  runHealthChecks();
}

export function stopHealthChecker(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    console.log('[HealthChecker] Stopped');
  }
}

export function getHealthStates(): HealthState[] {
  return Array.from(healthStates.values());
}
