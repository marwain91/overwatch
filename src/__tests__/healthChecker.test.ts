import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

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
      const timer = setTimeout(() => reject(new Error('no health:change emitted')), 3000);
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
