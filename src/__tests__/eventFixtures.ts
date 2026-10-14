import type { ContainerEvent, MetricsSnapshot } from '../services/eventBus';
import type { ContainerMetrics, TenantMetrics } from '../services/metricsCollector';

// Builders fill every required field, so adding a required field to these
// payload types breaks the tests at compile time instead of passing silently.
export function containerEvent(overrides: Partial<ContainerEvent> = {}): ContainerEvent {
  return {
    action: 'die',
    containerName: 'app-t1-web',
    containerId: 'abc123',
    time: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function containerMetrics(overrides: Partial<ContainerMetrics> = {}): ContainerMetrics {
  return {
    containerId: 'abc123',
    name: 'app-t1-web',
    appId: 'app',
    tenantId: 't1',
    service: 'web',
    cpuPercent: 0,
    memUsage: 0,
    memLimit: 0,
    memPercent: 0,
    netRx: 0,
    netTx: 0,
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function metricsSnapshot(
  containers: Array<Partial<ContainerMetrics>> = [],
  tenants: TenantMetrics[] = [],
): MetricsSnapshot {
  return { containers: containers.map(containerMetrics), tenants };
}
