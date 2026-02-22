export interface WSMessage<T = unknown> {
  type: WSMessageType;
  timestamp: string;
  data: T;
}

export type WSMessageType =
  | 'tenant:status'
  | 'container:event'
  | 'metrics:snapshot'
  | 'health:change'
  | 'alert:fired'
  | 'alert:resolved';

export interface ContainerEvent {
  action: string;
  containerName: string;
  containerId: string;
  time: string;
}

export interface ContainerMetricsWS {
  containerId: string;
  name: string;
  tenantId: string;
  service: string;
  cpuPercent: number;
  memUsage: number;
  memLimit: number;
  memPercent: number;
  netRx: number;
  netTx: number;
}

export interface TenantMetricsWS {
  tenantId: string;
  totalCpu: number;
  totalMem: number;
  totalMemLimit: number;
  containerCount: number;
}

export interface MetricsSnapshot {
  containers: ContainerMetricsWS[];
  tenants: TenantMetricsWS[];
}

export interface HealthChange {
  containerName: string;
  tenantId: string;
  service: string;
  previousState: string;
  newState: string;
  consecutiveFailures: number;
  lastCheck: string;
}

export interface AlertEvent {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: string;
  message: string;
  tenantId?: string;
  containerName?: string;
  firedAt: string;
  resolvedAt?: string;
}

export function createWSMessage<T>(type: WSMessageType, data: T): WSMessage<T> {
  return {
    type,
    timestamp: new Date().toISOString(),
    data,
  };
}
