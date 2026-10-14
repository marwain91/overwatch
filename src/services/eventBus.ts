import { EventEmitter } from 'events';
import type { ContainerMetrics, TenantMetrics } from './metricsCollector';
import type { AlertHistoryEntry } from '../notifications/types';

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

export interface ContainerEvent {
  action: string;
  containerName: string;
  containerId: string | undefined;
  time: string;
}

export type HealthState = 'healthy' | 'unhealthy' | 'unknown';

export interface HealthChange {
  containerName: string;
  appId: string;
  tenantId: string;
  service: string;
  previousState: HealthState;
  newState: HealthState;
  consecutiveFailures: number;
  lastCheck: string;
}

export interface MetricsSnapshot {
  containers: ContainerMetrics[];
  tenants: TenantMetrics[];
}

/** Events relayed to every authenticated WebSocket client. */
export interface BroadcastEventMap {
  'metrics:snapshot': MetricsSnapshot;
  'container:event': ContainerEvent;
  'health:change': HealthChange;
  'alert:fired': AlertHistoryEntry;
  'alert:resolved': AlertHistoryEntry;
  'tenant:update:progress': TenantUpdateProgress;
}

/**
 * Every bus event and its payload. `containers:existence` is internal (the
 * metrics collector tells the alert engine which containers exist; it names
 * every container on the host, so it is never broadcast).
 */
export interface EventMap extends BroadcastEventMap {
  'containers:existence': string[];
}

export type BroadcastEvent = keyof BroadcastEventMap;

type Listener<K extends keyof EventMap> = (payload: EventMap[K]) => void;

/** The EventEmitter API, with event names and payloads checked against `EventMap`. */
export interface TypedEventBus extends Omit<EventEmitter, 'emit' | 'on' | 'once' | 'off' | 'addListener' | 'removeListener'> {
  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): boolean;
  on<K extends keyof EventMap>(event: K, listener: Listener<K>): this;
  once<K extends keyof EventMap>(event: K, listener: Listener<K>): this;
  off<K extends keyof EventMap>(event: K, listener: Listener<K>): this;
  addListener<K extends keyof EventMap>(event: K, listener: Listener<K>): this;
  removeListener<K extends keyof EventMap>(event: K, listener: Listener<K>): this;
}

const eventBus = new EventEmitter() as unknown as TypedEventBus;
eventBus.setMaxListeners(20);

export { eventBus };
