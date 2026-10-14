import type { BroadcastEvent } from '../services/eventBus';

export interface WSMessage<T = unknown> {
  type: WSMessageType;
  timestamp: string;
  data: T;
}

export type WSMessageType = 'tenant:status' | BroadcastEvent;

export function createWSMessage<T>(type: WSMessageType, data: T): WSMessage<T> {
  return {
    type,
    timestamp: new Date().toISOString(),
    data,
  };
}
