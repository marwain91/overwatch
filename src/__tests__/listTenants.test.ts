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
});
