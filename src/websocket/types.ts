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
