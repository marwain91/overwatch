import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('dockerode');
  vi.doUnmock('net');
  vi.doUnmock('../services/app');
  vi.doUnmock('node-cron');
  vi.restoreAllMocks();
});

const N = 25;
const names = Array.from({ length: N }, (_, i) => `app-t${String(i).padStart(2, '0')}-web`);

function mockWorld(connect: (name: string, onConnect: () => void, socket: EventEmitter) => void) {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.doMock('node-cron', () => ({
    default: { validate: () => true, schedule: () => ({ stop: () => {} }) },
  }));
  vi.doMock('dockerode', () => ({
    default: class {
      async listContainers() {
        return names.map(n => ({
          Id: n.padEnd(64, '0'), Names: [`/${n}`],
          Labels: {
            'com.overwatch.managed': 'true', 'com.overwatch.app-id': 'app',
            'com.overwatch.tenant-id': n.split('-')[1], 'com.overwatch.service': 'web',
          },
        }));
      }
    },
  }));
  vi.doMock('net', () => {
    const createConnection = (opts: { host: string }, onConnect: () => void) => {
      const socket = Object.assign(new EventEmitter(), { destroy: () => {} });
      connect(opts.host, onConnect, socket);
      return socket;
    };
    return { default: { createConnection }, createConnection };
  });
  vi.doMock('../services/app', () => ({
    listApps: vi.fn(async () => [{ id: 'app', services: [{ name: 'web', ports: { internal: 80 }, health_check: { type: 'tcp', port: 80 } }] }]),
  }));
}

describe('health check concurrency', () => {
  it('runs checks in parallel, capped at 10, and emits in container order', async () => {
    let inFlight = 0;
    let peak = 0;
    mockWorld((host, onConnect, socket) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      const idx = names.indexOf(host);
      // Earlier containers answer slower, so completion order is reversed.
      setTimeout(() => {
        inFlight--;
        if (idx % 7 === 3) socket.emit('error', new Error('refused'));
        else onConnect();
      }, 5 + (N - idx));
    });
    const { eventBus } = await import('../services/eventBus');
    const seen: string[] = [];
    eventBus.on('health:change', (c: any) => seen.push(c.containerName));
    const { startHealthChecker, stopHealthChecker, getHealthStates } = await import('../services/healthChecker');
    startHealthChecker();
    await vi.waitFor(() => expect(seen).toHaveLength(N), { timeout: 4000 });
    stopHealthChecker();

    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(10);
    expect(seen).toEqual(names);
    expect(getHealthStates().filter(s => s.state === 'unhealthy')).toHaveLength(names.filter((_, i) => i % 7 === 3).length);
  });

  it('one hung or throwing check does not stop the others from being recorded', async () => {
    mockWorld((host, onConnect) => {
      if (host === names[0]) throw new Error('boom');
      setImmediate(onConnect);
    });
    const { eventBus } = await import('../services/eventBus');
    const seen: any[] = [];
    eventBus.on('health:change', (c: any) => seen.push(c));
    const { startHealthChecker, stopHealthChecker } = await import('../services/healthChecker');
    startHealthChecker();
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(N), { timeout: 4000 });
    stopHealthChecker();
    expect(seen[0]).toMatchObject({ containerName: names[0], newState: 'unhealthy' });
    expect(seen.slice(1).every(c => c.newState === 'healthy')).toBe(true);
  });
});
