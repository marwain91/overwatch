import { docker, getManagedContainerNamePattern } from './docker';
import { eventBus } from './eventBus';
import { listApps } from './app';

let eventStream: NodeJS.ReadableStream | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

const PATTERN_MAX_AGE_MS = 60_000;
const MAX_BUFFER_BYTES = 1024 * 1024;
const MANAGED_LABEL = 'com.overwatch.managed';

let namePattern: RegExp | null = null;
let patternBuiltAt = 0;
let patternRefresh: Promise<void> | null = null;

// Rebuilt on every reconnect and at most every 60s while events flow, so apps
// added after boot are recognised. Only a fallback for pre-label containers.
async function refreshPattern(): Promise<void> {
  if (!patternRefresh) {
    patternRefresh = (async () => {
      try {
        const apps = await listApps();
        namePattern = getManagedContainerNamePattern(apps.map(a => a.id));
      } finally {
        // Also on failure: back off for the normal interval instead of
        // retrying listApps() on every unlabeled event.
        patternBuiltAt = Date.now();
      }
    })().finally(() => { patternRefresh = null; });
  }
  return patternRefresh;
}

async function handleLine(line: string): Promise<void> {
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return; // ignore parse errors
  }
  const attrs = event?.Actor?.Attributes;
  const name = attrs?.name;
  if (!name) return;

  if (attrs[MANAGED_LABEL] !== 'true') {
    if (Date.now() - patternBuiltAt >= PATTERN_MAX_AGE_MS) {
      await refreshPattern().catch((err) => {
        console.error('[DockerEvents] Failed to refresh app list:', err?.message || err);
      });
    }
    if (!namePattern || !namePattern.test(name)) return;
  }

  eventBus.emit('container:event', {
    action: event.Action,
    containerName: name,
    containerId: event.Actor?.ID?.substring(0, 12),
    time: new Date(event.time * 1000).toISOString(),
  });
}

async function startListening(): Promise<void> {
  await refreshPattern();

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

    // Docker sends newline-delimited JSON; a chunk can hold several events or
    // end mid-event, so buffer the tail until its newline arrives. Lines are
    // handled in order through a chain (the pattern refresh is async).
    let buffer = '';
    let discarding = false; // skipping the rest of an oversized line
    let queue: Promise<void> = Promise.resolve();
    stream.on('data', (chunk: Buffer) => {
      let text = chunk.toString();
      if (discarding) {
        const nl = text.indexOf('\n');
        if (nl === -1) return;
        text = text.slice(nl + 1);
        discarding = false;
      }
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      if (buffer.length > MAX_BUFFER_BYTES) {
        console.error('[DockerEvents] Event line exceeded 1 MB without a newline; discarding it');
        buffer = '';
        discarding = true;
      }
      for (const line of lines) {
        if (!line.trim()) continue;
        queue = queue.then(() => handleLine(line)).catch(() => {});
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

// startListening() rejects when listApps() throws (e.g. an apps.d file caught
// mid-write). Left uncaught that is an unhandled rejection, which kills the
// process; retry on the normal reconnect cadence instead.
function onStartFailure(err: unknown): void {
  console.error('[DockerEvents] Failed to start listener:', (err as Error)?.message || err);
  scheduleReconnect();
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    console.log('[DockerEvents] Reconnecting...');
    startListening().catch(onStartFailure);
  }, 5000);
}

export function startDockerEventListener(): void {
  startListening().catch(onStartFailure);
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
