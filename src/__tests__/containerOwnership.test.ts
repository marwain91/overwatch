import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import * as http from 'http';
import * as yaml from 'js-yaml';

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('dockerode');
  vi.doUnmock('child_process');
  vi.doUnmock('../config');
  vi.doUnmock('../config/loader');
  vi.doUnmock('../adapters/database');
  vi.doUnmock('../services/app');
  vi.doUnmock('../services/envVars');
  vi.doUnmock('../services/docker');
  vi.doUnmock('../services/manifestExtractor');
  vi.doUnmock('../services/tenantAppDef');
  vi.doUnmock('../services/tenantTraefik');
  vi.doUnmock('../middleware/requireRole');
});

function baseConfig() {
  return {
    project: { name: 'Test', prefix: 'test', db_prefix: 'test' },
    database: {
      type: 'mariadb',
      host: 'db',
      port: 3306,
      root_user: 'root',
      root_password_env: 'MYSQL_ROOT_PASSWORD',
      container_name: 'db',
    },
    networking: {
      external_network: 'test-network',
      internal_network_template: '${prefix}-${tenantId}-internal',
      apps_path: '/app/apps',
    },
    traefik: {
      log_level: 'INFO',
      tls_termination: 'upstream',
      upstream_entrypoint: 'web',
    },
  } as any;
}

function baseApp(id = 'customer-portal') {
  return {
    id,
    name: 'Customer Portal',
    domain_template: '*.example.test',
    registry: { type: 'ghcr', url: 'ghcr.io', repository: 'acme/customer-portal', auth: { type: 'token' } },
    services: [
      { name: 'web-api', image_suffix: 'web-api', required: true, ports: { internal: 3000 } },
      { name: 'worker', image_suffix: 'worker', required: false },
    ],
    default_image_tag: 'latest',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as any;
}

async function requestApp(app: express.Express, method: string, route: string): Promise<{ status: number; body: any }> {
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind to a port');
    const res = await fetch(`http://127.0.0.1:${address.port}${route}`, { method, headers: { connection: 'close' } });
    return { status: res.status, body: await res.json() };
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
}

describe('container ownership labels and scoped operations', () => {
  it('adds Overwatch ownership labels to every generated tenant service', async () => {
    const { generateComposeFile } = await import('../services/composeGenerator');

    const yml = generateComposeFile({
      app: baseApp('customer-portal'),
      tenantId: 'tenant-one',
      domain: 'tenant-one.example.test',
      config: baseConfig(),
    });

    const services = (yaml.load(yml) as any).services;
    expect(Object.keys(services)).toEqual(['web-api', 'worker']);
    for (const name of ['web-api', 'worker']) {
      expect(services[name].labels).toEqual(expect.arrayContaining([
        'com.overwatch.managed=true',
        'com.overwatch.app-id=customer-portal',
        'com.overwatch.tenant-id=tenant-one',
        `com.overwatch.service=${name}`,
      ]));
    }
  }, 30000);

  it('discovers hyphenated app and tenant ids from labels instead of dashed names', async () => {
    vi.doMock('dockerode', () => ({
      default: class DockerMock {
        async listContainers() {
          return [{
            Id: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
            Names: ['/compose-generated-name'],
            Status: 'Up 1 minute',
            State: 'running',
            Image: 'ghcr.io/acme/customer-portal/web-api:latest',
            Created: 1760000000,
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
    vi.doMock('../services/app', () => ({ listApps: vi.fn(async () => [baseApp('customer-portal')]) }));

    const { listContainers } = await import('../services/docker');
    await expect(listContainers()).resolves.toEqual([expect.objectContaining({
      id: 'abcdef123456',
      appId: 'customer-portal',
      tenantId: 'tenant-one',
      service: 'web-api',
    })]);
  });

  it('refuses logs for Docker ids not returned by managed container discovery', async () => {
    const getContainerLogs = vi.fn(async () => 'secret logs');
    vi.doMock('../services/docker', () => ({
      listContainers: vi.fn(async () => []),
      findManagedContainer: vi.fn(async () => null),
      getContainerLogs,
      restartContainer: vi.fn(),
      listTenants: vi.fn(async () => []),
      extractContainerInfo: vi.fn(() => null),
    }));
    vi.doMock('../middleware/requireRole', () => ({ requireRole: () => (_req: any, _res: any, next: any) => next() }));

    const { default: statusRouter } = await import('../routes/status');
    const app = express();
    app.use('/api/status', statusRouter);

    const response = await requestApp(app, 'GET', '/api/status/containers/abcdef123456/logs');
    expect(response.status).toBe(404);
    expect(getContainerLogs).not.toHaveBeenCalled();
  });

  it('refuses restart for Docker ids not returned by managed container discovery', async () => {
    const restartContainer = vi.fn(async () => undefined);
    vi.doMock('../services/docker', () => ({
      listContainers: vi.fn(async () => []),
      findManagedContainer: vi.fn(async () => null),
      getContainerLogs: vi.fn(),
      restartContainer,
      listTenants: vi.fn(async () => []),
      extractContainerInfo: vi.fn(() => null),
    }));
    vi.doMock('../middleware/requireRole', () => ({ requireRole: () => (_req: any, _res: any, next: any) => next() }));

    const { default: statusRouter } = await import('../routes/status');
    const app = express();
    app.use('/api/status', statusRouter);

    const response = await requestApp(app, 'POST', '/api/status/containers/abcdef123456/restart');
    expect(response.status).toBe(404);
    expect(restartContainer).not.toHaveBeenCalled();
  });
});

