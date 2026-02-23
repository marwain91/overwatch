import { docker } from './docker';
import { eventBus } from './eventBus';
import { getContainerPrefix } from '../config';

let eventStream: NodeJS.ReadableStream | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function getContainerPattern(): RegExp {
  const prefix = getContainerPrefix();
  // Match: {prefix}-{appId}-{tenantId}-{service}(-N)?
  return new RegExp(`^/?${prefix}-[a-z0-9-]+-[a-z0-9-]+-[a-z0-9-]+(?:-\\d+)?$`);
}

function startListening(): void {
  const pattern = getContainerPattern();

  docker.getEvents({
    filters: {
      type: ['container'],
      event: ['start', 'stop', 'die'],
    },
  }, (err, stream) => {
    if (err || !stream) {
      console.error('[DockerEvents] Failed to connect:', err?.message);
      scheduleReconnect();
      return;
    }

    eventStream = stream;
    console.log('[DockerEvents] Listening for container events');

    stream.on('data', (chunk: Buffer) => {
      try {
        const event = JSON.parse(chunk.toString());
        const name = event.Actor?.Attributes?.name;
        if (!name || !pattern.test(name)) return;

        eventBus.emit('container:event', {
          action: event.Action,
          containerName: name,
          containerId: event.Actor?.ID?.substring(0, 12),
          time: new Date(event.time * 1000).toISOString(),
        });
      } catch {
        // ignore parse errors
      }
    });

    stream.on('error', (error: Error) => {
      console.error('[DockerEvents] Stream error:', error.message);
      scheduleReconnect();
    });

    stream.on('end', () => {
      console.log('[DockerEvents] Stream ended');
      scheduleReconnect();
    });
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    console.log('[DockerEvents] Reconnecting...');
    startListening();
  }, 5000);
}

export function startDockerEventListener(): void {
  startListening();
}

export function stopDockerEventListener(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (eventStream) {
    (eventStream as any).destroy?.();
    eventStream = null;
  }
}
