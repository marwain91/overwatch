export interface WSMessage<T = unknown> {
  type: WSMessageType;
  timestamp: string;
  data: T;
}

export type WSMessageType =
  | 'tenant:status'
  | 'tenant:update:progress'
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

/**
 * Progress event emitted by long-running tenant operations (currently
 * `updateTenant`). Frontend subscribes to these to show step-by-step
 * status in the tenant update modal — replaces the blind "Updating..."
 * state where the user can't tell if a pull is running or the call died.
 */
export type TenantUpdateStep =
  | 'manifest'       // extracting + applying /overwatch/app.json from the new image
  | 'config'         // regenerating .env + shared.env + docker-compose.yml
  | 'pull'           // docker compose pull (usually the slowest step)
  | 'restart'        // docker compose up -d --force-recreate
  | 'done'           // terminal, success
  | 'failed';        // terminal, failure

export type TenantUpdateStatus = 'started' | 'completed' | 'skipped' | 'failed';

export interface TenantUpdateProgress {
  appId: string;
  tenantId: string;
  newTag: string;
  step: TenantUpdateStep;
  status: TenantUpdateStatus;
  detail?: string;
}

export function createWSMessage<T>(type: WSMessageType, data: T): WSMessage<T> {
  return {
    type,
    timestamp: new Date().toISOString(),
    data,
  };
}
