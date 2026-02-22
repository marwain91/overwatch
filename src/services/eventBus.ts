import { EventEmitter } from 'events';

const eventBus = new EventEmitter();
eventBus.setMaxListeners(20);

export type EventType =
  | 'container:event'
  | 'metrics:snapshot'
  | 'health:change'
  | 'alert:fired'
  | 'alert:resolved';

export { eventBus };
