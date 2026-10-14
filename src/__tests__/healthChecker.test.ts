import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('dockerode');
  vi.doUnmock('net');
  vi.doUnmock('../services/app');
});

describe('health checker container identity', () => {
  it('checks hyphenated app ids by reading container labels', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.doMock('dockerode', () => ({
      default: class DockerMock {
        async listContainers() {
          return [{
            Id: 'abcdef123456',
            Names: ['/customer-portal-tenant-one-web-api'],
            Labels: {
              'com.overwatch.managed': 'true',
              'com.overwatch.app-id': 'customer-portal',
              'com.overwatch.tenant-id': 'tenant-one',
              'com.overwatch.service': 'web-api',
            },
          }];
        }
      },
    }));
    // TCP check always connects, so the result only depends on identification.
    vi.doMock('net', () => {
      const createConnection = (_opts: unknown, onConnect: () => void) => {
        const socket = Object.assign(new EventEmitter(), { destroy: () => {} });
        setImmediate(onConnect);
        return socket;
      };
      return { default: { createConnection }, createConnection };
    });
    vi.doMock('../services/app', () => ({
      listApps: vi.fn(async () => [{
        id: 'customer-portal',
        services: [{ name: 'web-api', ports: { internal: 3000 }, health_check: { type: 'tcp', port: 3000 } }],
      }]),
    }));

    const { eventBus } = await import('../services/eventBus');
    const change = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no health:change emitted')), 15_000);
      eventBus.once('health:change', (data) => { clearTimeout(timer); resolve(data); });
    });
    const { startHealthChecker, stopHealthChecker } = await import('../services/healthChecker');
    startHealthChecker();
    try {
      await expect(change).resolves.toMatchObject({
        appId: 'customer-portal',
        tenantId: 'tenant-one',
        service: 'web-api',
        newState: 'healthy',
      });
    } finally {
      stopHealthChecker();
    }
  });
});

describe('health checker retention', () => {
  it('emits a transition to unknown after 10 minutes and forgets containers that no longer exist', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    let stopped: any[] = [];
    let running: any[] = [{
      Id: 'abcdef123456', Names: ['/app-t1-web'],
      Labels: { 'com.overwatch.managed': 'true', 'com.overwatch.app-id': 'app', 'com.overwatch.tenant-id': 't1', 'com.overwatch.service': 'web' },
    }];
    vi.doMock('node-cron', () => ({
      default: { validate: () => true, schedule: (_e: string, fn: () => void) => { (globalThis as any).__hcTick = fn; return { stop: () => {} }; } },
    }));
    vi.doMock('dockerode', () => ({ default: class { async listContainers(o: any) { return o?.all ? [...running, ...stopped] : running; } } }));
    vi.doMock('net', () => {
      const createConnection = (_o: unknown, onConnect: () => void) => {
        const socket = Object.assign(new EventEmitter(), { destroy: () => {} });
        Promise.resolve().then(onConnect);
        return socket;
      };
      return { default: { createConnection }, createConnection };
    });
    vi.doMock('../services/app', () => ({
      listApps: vi.fn(async () => [{ id: 'app', services: [{ name: 'web', ports: { internal: 80 }, health_check: { type: 'tcp', port: 80 } }] }]),
    }));

    const { eventBus } = await import('../services/eventBus');
    const changes: any[] = [];
    eventBus.on('health:change', (c) => changes.push(c));
    const mod = await import('../services/healthChecker');
    mod.startHealthChecker();
    await vi.advanceTimersByTimeAsync(0);
    expect(mod.getHealthStates()).toHaveLength(1);
    expect(changes.map(c => c.newState)).toEqual(['healthy']);

    stopped = [{ Id: 'abcdef123456', Names: ['/app-t1-web'] }];
    running = [];
    vi.setSystemTime(new Date('2026-01-01T00:09:00Z'));
    await (globalThis as any).__hcTick();
    expect(mod.getHealthStates()).toHaveLength(1);

    vi.setSystemTime(new Date('2026-01-01T00:10:01Z'));
    await (globalThis as any).__hcTick();
    expect(mod.getHealthStates()).toHaveLength(1); // stopped but still exists: kept as unknown
    expect(mod.getHealthStates()[0].state).toBe('unknown');

    stopped = [];
    await (globalThis as any).__hcTick();
    expect(mod.getHealthStates()).toHaveLength(0);
    expect(changes.map(c => c.newState)).toEqual(['healthy', 'unknown']);
    expect(changes[1]).toMatchObject({ containerName: 'app-t1-web', previousState: 'healthy' });
    mod.stopHealthChecker();
    vi.useRealTimers();
    vi.doUnmock('node-cron');
  });

  it('evicts a state with no lastCheck as soon as its container no longer exists', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    let running: any[] = [{
      Id: 'abcdef123456', Names: ['/app-t1-web'],
      Labels: { 'com.overwatch.managed': 'true', 'com.overwatch.app-id': 'app', 'com.overwatch.tenant-id': 't1', 'com.overwatch.service': 'web' },
    }];
    vi.doMock('node-cron', () => ({
      default: { validate: () => true, schedule: (_e: string, fn: () => void) => { (globalThis as any).__hcTick = fn; return { stop: () => {} }; } },
    }));
    vi.doMock('dockerode', () => ({ default: class { async listContainers() { return running; } } }));
    vi.doMock('net', () => {
      const createConnection = (_o: unknown, onConnect: () => void) => {
        const socket = Object.assign(new EventEmitter(), { destroy: () => {} });
        Promise.resolve().then(onConnect);
        return socket;
      };
      return { default: { createConnection }, createConnection };
    });
    vi.doMock('../services/app', () => ({
      listApps: vi.fn(async () => [{ id: 'app', services: [{ name: 'web', ports: { internal: 80 }, health_check: { type: 'tcp', port: 80 } }] }]),
    }));

    const mod = await import('../services/healthChecker');
    mod.startHealthChecker();
    await vi.advanceTimersByTimeAsync(0);
    expect(mod.getHealthStates()).toHaveLength(1);

    // A state that never recorded a check must not be exempt from eviction.
    mod.getHealthStates()[0].lastCheck = null;
    running = [];
    vi.setSystemTime(new Date('2026-01-01T00:00:05Z'));
    await (globalThis as any).__hcTick();
    expect(mod.getHealthStates()).toHaveLength(0);
    mod.stopHealthChecker();
    vi.useRealTimers();
    vi.doUnmock('node-cron');
  });
});
