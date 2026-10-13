import { EventEmitter } from 'events';

const eventBus = new EventEmitter();
eventBus.setMaxListeners(20);

export { eventBus };
