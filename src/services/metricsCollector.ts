import cron, { ScheduledTask } from 'node-cron';
import { docker, extractContainerInfo } from './docker';
import { eventBus } from './eventBus';
import { getContainerPrefix } from '../config';

export interface ContainerMetrics {
  containerId: string;
  name: string;
  appId: string;
  tenantId: string;
  service: string;
  cpuPercent: number;
  memUsage: number;
  memLimit: number;
  memPercent: number;
  netRx: number;
  netTx: number;
  timestamp: string;
}

export interface TenantMetrics {
  appId: string;
  tenantId: string;
  totalCpu: number;
  totalMem: number;
  totalMemLimit: number;
  containerCount: number;
}

class RingBuffer<T> {
  private buffer: T[];
  private head: number = 0;
  private count: number = 0;

  constructor(private capacity: number) {
    this.buffer = new Array(capacity);
  }

  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  toArray(): T[] {
    if (this.count === 0) return [];
    if (this.count < this.capacity) {
      return this.buffer.slice(0, this.count);
    }
    return [...this.buffer.slice(this.head), ...this.buffer.slice(0, this.head)];
  }

  latest(): T | undefined {
    if (this.count === 0) return undefined;
    const idx = (this.head - 1 + this.capacity) % this.capacity;
    return this.buffer[idx];
  }
}

const metricsHistory = new Map<string, RingBuffer<ContainerMetrics>>();
let scheduledTask: ScheduledTask | null = null;
let collecting = false;

function getContainerPattern(): RegExp {
  const prefix = getContainerPrefix();
  return new RegExp(`^/?${prefix}-[a-z0-9-]+-[a-z0-9-]+-[a-z0-9-]+(?:-\\d+)?$`);
}

function calculateCpuPercent(stats: any): number {
  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
  const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
  const cpuCount = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage.percpu_usage?.length || 1;

  if (systemDelta <= 0 || cpuDelta < 0) return 0;
  return (cpuDelta / systemDelta) * cpuCount * 100;
}

function getNetworkStats(stats: any): { rx: number; tx: number } {
  const networks = stats.networks;
  if (!networks) return { rx: 0, tx: 0 };

  let rx = 0;
  let tx = 0;
  for (const iface of Object.values(networks) as any[]) {
    rx += iface.rx_bytes || 0;
    tx += iface.tx_bytes || 0;
  }
  return { rx, tx };
}

async function collectMetrics(): Promise<void> {
  if (collecting) return;
  collecting = true;

  try {
    const containers = await docker.listContainers({ filters: { status: ['running'] } });
    const pattern = getContainerPattern();

    const managedContainers = containers.filter(c =>
      c.Names.some(n => pattern.test(n))
    );

    const results = await Promise.allSettled(
      managedContainers.map(async (c) => {
        const container = docker.getContainer(c.Id);
        const stats = await container.stats({ stream: false });
        const name = c.Names[0].replace(/^\//, '');
        const info = extractContainerInfo(name);
        if (!info) return null;

        const cpuPercent = calculateCpuPercent(stats);
        const memUsage = stats.memory_stats.usage || 0;
        const memLimit = stats.memory_stats.limit || 0;
        const memPercent = memLimit > 0 ? (memUsage / memLimit) * 100 : 0;
        const net = getNetworkStats(stats);

        const metrics: ContainerMetrics = {
          containerId: c.Id.substring(0, 12),
          name,
          appId: info.appId,
          tenantId: info.tenantId,
          service: info.service,
          cpuPercent: Math.round(cpuPercent * 100) / 100,
          memUsage,
          memLimit,
          memPercent: Math.round(memPercent * 100) / 100,
          netRx: net.rx,
          netTx: net.tx,
          timestamp: new Date().toISOString(),
        };

        // Store in history
        if (!metricsHistory.has(name)) {
          metricsHistory.set(name, new RingBuffer<ContainerMetrics>(240));
        }
        metricsHistory.get(name)!.push(metrics);

        return metrics;
      })
    );

    const allMetrics: ContainerMetrics[] = results
      .filter((r): r is PromiseFulfilledResult<ContainerMetrics | null> => r.status === 'fulfilled')
      .map(r => r.value)
      .filter((m): m is ContainerMetrics => m !== null);

    // Aggregate per-tenant (keyed by appId:tenantId)
    const tenantMap = new Map<string, TenantMetrics>();
    for (const m of allMetrics) {
      const key = `${m.appId}:${m.tenantId}`;
      if (!tenantMap.has(key)) {
        tenantMap.set(key, {
          appId: m.appId,
          tenantId: m.tenantId,
          totalCpu: 0,
          totalMem: 0,
          totalMemLimit: 0,
          containerCount: 0,
        });
      }
      const t = tenantMap.get(key)!;
      t.totalCpu += m.cpuPercent;
      t.totalMem += m.memUsage;
      t.totalMemLimit = Math.max(t.totalMemLimit, m.memLimit);
      t.containerCount++;
    }

    const tenantMetrics = Array.from(tenantMap.values()).map(t => ({
      ...t,
      totalCpu: Math.round(t.totalCpu * 100) / 100,
    }));

    eventBus.emit('metrics:snapshot', { containers: allMetrics, tenants: tenantMetrics });
  } catch (error: any) {
    console.error('[MetricsCollector] Collection error:', error.message);
  } finally {
    collecting = false;
  }
}

export function startMetricsCollector(intervalSeconds: number = 15): void {
  const cronExpr = `*/${intervalSeconds} * * * * *`;

  if (!cron.validate(cronExpr)) {
    console.error(`[MetricsCollector] Invalid interval: ${intervalSeconds}s`);
    return;
  }

  scheduledTask = cron.schedule(cronExpr, collectMetrics, {
    name: 'metrics-collector',
    noOverlap: true,
  });

  console.log(`[MetricsCollector] Started (interval: ${intervalSeconds}s)`);

  // Collect immediately on start
  collectMetrics();
}

export function stopMetricsCollector(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    console.log('[MetricsCollector] Stopped');
  }
}

export function getMetrics(appId?: string, tenantId?: string): { containers: ContainerMetrics[]; tenants: TenantMetrics[] } {
  const containers: ContainerMetrics[] = [];
  const tenantMap = new Map<string, TenantMetrics>();

  for (const [, history] of metricsHistory) {
    const latest = history.latest();
    if (!latest) continue;
    if (appId && latest.appId !== appId) continue;
    if (tenantId && latest.tenantId !== tenantId) continue;
    containers.push(latest);

    const key = `${latest.appId}:${latest.tenantId}`;
    if (!tenantMap.has(key)) {
      tenantMap.set(key, {
        appId: latest.appId,
        tenantId: latest.tenantId,
        totalCpu: 0,
        totalMem: 0,
        totalMemLimit: 0,
        containerCount: 0,
      });
    }
    const t = tenantMap.get(key)!;
    t.totalCpu += latest.cpuPercent;
    t.totalMem += latest.memUsage;
    t.totalMemLimit = Math.max(t.totalMemLimit, latest.memLimit);
    t.containerCount++;
  }

  const tenants = Array.from(tenantMap.values()).map(t => ({
    ...t,
    totalCpu: Math.round(t.totalCpu * 100) / 100,
  }));

  return { containers, tenants };
}

export function getMetricsHistory(containerName: string): ContainerMetrics[] {
  return metricsHistory.get(containerName)?.toArray() || [];
}
