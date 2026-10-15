import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

let appsDir: string;
beforeEach(async () => {
  appsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-tenants-'));
});
afterEach(async () => {
  vi.resetModules();
  vi.doUnmock('dockerode');
  vi.doUnmock('../services/app');
  vi.doUnmock('../config');
  vi.doUnmock('../services/tenantStore');
  vi.doUnmock('../services/docker');
  await fs.rm(appsDir, { recursive: true, force: true });
});

const label = (app: string, tenant: string, svc: string) => ({
  'com.overwatch.managed': 'true',
  'com.overwatch.app-id': app,
  'com.overwatch.tenant-id': tenant,
  'com.overwatch.service': svc,
});
const container = (app: string, tenant: string, svc: string, state = 'running') => ({
  Id: `${app}${tenant}${svc}`.padEnd(64, '0'),
  Names: [`/${app}-${tenant}-${svc}`],
  Status: state, State: state, Image: 'img', Created: 1760000000,
  Labels: label(app, tenant, svc),
});
const appDef = (id: string) => ({
  id,
  services: [
    { name: 'web', required: true },
    { name: 'init', is_init_container: true },
  ],
});

async function tenantDir(app: string, tenant: string, env = 'TENANT_DOMAIN=a.example\nIMAGE_TAG=v1\n') {
  const dir = path.join(appsDir, app, 'tenants', tenant);
  await fs.mkdir(dir, { recursive: true });
  if (env) await fs.writeFile(path.join(dir, '.env'), env);
}

function setup(containers: any[], opts: { dockerFails?: boolean } = {}) {
  const listContainers = vi.fn(async () => {
    if (opts.dockerFails) throw new Error('docker down');
    return containers;
  });
  const listApps = vi.fn(async () => [appDef('alpha'), appDef('beta')]);
  vi.doMock('dockerode', () => ({ default: class { listContainers = listContainers; } }));
  vi.doMock('../services/app', () => ({ listApps }));
  vi.doMock('../config', () => ({ getAppsDir: () => appsDir, loadConfig: () => ({}) }));
  return { listContainers, listApps };
}

describe('listTenants', () => {
  it('queries Docker and the app store once for N tenants and groups containers per tenant', async () => {
    await tenantDir('alpha', 't1');
    await tenantDir('alpha', 't2');
    await tenantDir('beta', 't3');
    const { listContainers, listApps } = setup([
      container('alpha', 't1', 'web'), container('alpha', 't1', 'init', 'exited'),
      container('alpha', 't2', 'web', 'exited'),
      container('beta', 't3', 'web'),
    ]);
    const { listTenants } = await import('../services/docker');
    const tenants = await listTenants();

    expect(listContainers).toHaveBeenCalledTimes(1);
    expect(listApps).toHaveBeenCalledTimes(1);
    const by = Object.fromEntries(tenants.map(t => [`${t.appId}:${t.tenantId}`, t]));
    expect(Object.keys(by).sort()).toEqual(['alpha:t1', 'alpha:t2', 'beta:t3']);
    expect(by['alpha:t1']).toMatchObject({ totalContainers: 1, runningContainers: 1, healthy: true, domain: 'a.example', version: 'v1' });
    expect(by['alpha:t1'].containers).toHaveLength(2);
    expect(by['alpha:t2']).toMatchObject({ totalContainers: 1, runningContainers: 0, healthy: false });
    expect(by['beta:t3'].containers).toHaveLength(1);
  });

  it('still lists tenants when the host has a container with no name', async () => {
    await tenantDir('alpha', 't1');
    // Docker reports Names: [] for some leftover build containers in "created" state.
    const nameless = { Id: 'f'.repeat(64), Names: [], Status: 'Created', State: 'created', Image: 'sha256:abc', Created: 1760000000, Labels: {} };
    setup([nameless, container('alpha', 't1', 'web')]);
    const { listTenants } = await import('../services/docker');
    const tenants = await listTenants();

    expect(tenants.map(t => `${t.appId}:${t.tenantId}`)).toEqual(['alpha:t1']);
    expect(tenants[0]).toMatchObject({ runningContainers: 1, healthy: true });
  });

  it('skips tenants without a .env and does not call Docker when no tenant has one', async () => {
    await tenantDir('alpha', 'noenv', '');
    const { listContainers } = setup([container('alpha', 'noenv', 'web')]);
    const { listTenants } = await import('../services/docker');
    await expect(listTenants()).resolves.toEqual([]);
    expect(listContainers).not.toHaveBeenCalled();
  });

  it('keeps today\'s behaviour when Docker fails: the tenants are skipped', async () => {
    await tenantDir('alpha', 't1');
    setup([], { dockerFails: true });
    const { listTenants } = await import('../services/docker');
    await expect(listTenants()).resolves.toEqual([]);
  });

  it('scans only the requested app when given one', async () => {
    await tenantDir('alpha', 't1');
    await tenantDir('beta', 't3');
    const reads: string[] = [];
    vi.doMock('../services/tenantStore', async () => {
      const actual = await vi.importActual<typeof import('../services/tenantStore')>('../services/tenantStore');
      return { ...actual, readTenantEnv: vi.fn(async (a: string, t: string) => { reads.push(`${a}:${t}`); return actual.readTenantEnv(a, t); }) };
    });
    setup([container('alpha', 't1', 'web'), container('beta', 't3', 'web')]);
    const { listTenants } = await import('../services/docker');

    const tenants = await listTenants('alpha');

    expect(tenants.map(t => `${t.appId}:${t.tenantId}`)).toEqual(['alpha:t1']);
    expect(reads).toEqual(['alpha:t1']);
  });

  it('reads tenant .env files in parallel, at most 16 at a time', async () => {
    for (let i = 0; i < 40; i++) await tenantDir('alpha', `t${i}`);
    let active = 0;
    let maxActive = 0;
    vi.doMock('../services/tenantStore', async () => {
      const actual = await vi.importActual<typeof import('../services/tenantStore')>('../services/tenantStore');
      return {
        ...actual,
        readTenantEnv: vi.fn(async (a: string, t: string) => {
          active++; maxActive = Math.max(maxActive, active);
          await new Promise(r => setTimeout(r, 5));
          active--;
          return actual.readTenantEnv(a, t);
        }),
      };
    });
    setup([]);
    const { listTenants } = await import('../services/docker');

    const tenants = await listTenants();

    expect(tenants).toHaveLength(40);
    expect(tenants.map(t => t.tenantId).sort()).toEqual(Array.from({ length: 40 }, (_, i) => `t${i}`).sort());
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(16);
  });

  it('GET /api/apps/:appId/tenants asks for that app only', async () => {
    const listTenants = vi.fn(async () => []);
    vi.doMock('../services/docker', () => ({ listTenants, startTenant: vi.fn(), stopTenant: vi.fn(), restartTenant: vi.fn() }));
    vi.doMock('../config', () => ({ getAppsDir: () => appsDir, loadConfig: () => ({}) }));
    const express = (await import('express')).default;
    const request = (await import('supertest')).default;
    const { default: router } = await import('../routes/tenants');
    const app = express();
    app.use('/api/apps/:appId/tenants', router);

    await request(app).get('/api/apps/alpha/tenants').expect(200, []);

    expect(listTenants).toHaveBeenCalledWith('alpha');
  });
});
