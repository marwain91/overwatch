import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let root: string;
let appsDir: string;
let dataDir: string;
const calls: Array<{ args: string[]; opts: any }> = [];
let active = 0;
let maxActive = 0;
let delayMs = 0;

async function mkTenant(app: string, id: string) {
  const p = path.join(appsDir, app, 'tenants', id);
  await fs.mkdir(p, { recursive: true });
  await fs.writeFile(path.join(p, '.env'), 'DB_NAME=test_x\n');
  await fs.writeFile(path.join(p, 'docker-compose.yml'), 'services: {}\n');
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-tenant-locks-'));
  appsDir = path.join(root, 'apps');
  dataDir = path.join(root, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  await mkTenant('demo', 'one');
  await mkTenant('demo', 'two');
  calls.length = 0; active = 0; maxActive = 0; delayMs = 0;
  vi.doMock('child_process', () => ({
    execFile: vi.fn((_cmd: string, args: string[], opts: any, cb: any) => {
      calls.push({ args, opts });
      active++; maxActive = Math.max(maxActive, active);
      setTimeout(() => { active--; cb(null, '', ''); }, delayMs);
      return { on: () => {} };
    }),
  }));
  vi.doMock('../config', () => ({
    loadConfig: () => ({ project: { name: 'T', prefix: 'test', db_prefix: 'test' } }),
    getAppsDir: () => appsDir,
    getDataDir: () => dataDir,
    resolveAppDbPrefix: () => 'test',
  }));
  vi.doMock('../config/loader', () => ({ resolveCertResolver: () => ({ name: 'web', resolver: null }) }));
  vi.doMock('../adapters/database', () => ({
    getDatabaseAdapter: () => ({ initialize: vi.fn(async () => undefined), dropDatabase: vi.fn(async () => undefined) }),
  }));
  vi.doMock('../services/app', () => ({ getApp: vi.fn(async () => ({ id: 'demo', services: [] })), applyApp: vi.fn(), listApps: vi.fn(async () => []) }));
  vi.doMock('../services/envVars', () => ({ generateSharedEnvFile: vi.fn(), deleteTenantAllOverrides: vi.fn() }));
  vi.doMock('../adapters/registry', () => ({ ensureRegistryLogin: vi.fn(async () => undefined) }));
});

afterEach(async () => {
  vi.resetModules();
  for (const m of ['child_process', '../config', '../config/loader', '../adapters/database', '../services/app', '../services/envVars', '../adapters/registry']) vi.doUnmock(m);
  await fs.rm(root, { recursive: true, force: true });
});

describe('tenant compose shell-outs', () => {
  it('carry a timeout and maxBuffer', async () => {
    const { deleteTenant } = await import('../services/tenant');
    await deleteTenant('demo', 'one');
    const down = calls.find(c => c.args.includes('down'))!;
    expect(down.opts.timeout).toBeGreaterThan(0);
    expect(down.opts.maxBuffer).toBeGreaterThanOrEqual(16 * 1024 * 1024);
  });
});

describe('per-tenant lock', () => {
  it('serialises delete and stop of the same tenant', async () => {
    delayMs = 30;
    const { deleteTenant } = await import('../services/tenant');
    const { stopTenant } = await import('../services/docker');
    await mkTenant('demo', 'one');
    await Promise.all([stopTenant('demo', 'one'), deleteTenant('demo', 'one', true)]);
    expect(calls.length).toBe(2);
    expect(maxActive).toBe(1);
  });

  it('serialises start and stop of the same tenant', async () => {
    delayMs = 30;
    const { startTenant, stopTenant } = await import('../services/docker');
    await Promise.all([startTenant('demo', 'one'), stopTenant('demo', 'one')]);
    expect(maxActive).toBe(1);
  });

  it('does not serialise different tenants', async () => {
    delayMs = 40;
    const { stopTenant } = await import('../services/docker');
    await Promise.all([stopTenant('demo', 'one'), stopTenant('demo', 'two')]);
    expect(maxActive).toBe(2);
  });
});
