import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let tmpRoot: string;
let dataDir: string;
let appsDir: string;
const MASK = '••••••••';

const VALID = {
  id: 'acme', name: 'acme', domain_template: '*.acme.example',
  registry: { type: 'ghcr', url: 'ghcr.io', repository: 'ns/acme', auth: { type: 'token' } },
  services: [{ name: 'web', image_suffix: 'web', ports: { internal: 80 } }],
  default_image_tag: 'latest',
};

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-restore-lock-'));
  dataDir = path.join(tmpRoot, 'data');
  appsDir = path.join(tmpRoot, 'apps');
  await fs.mkdir(path.join(dataDir, 'apps.d'), { recursive: true });
  await fs.mkdir(path.join(appsDir, 'acme', 'tenants', 't1'), { recursive: true });
  vi.doMock('../config', () => ({
    getDataDir: () => dataDir,
    getAppsDir: () => appsDir,
    loadConfig: () => ({ project: { name: 'T', prefix: 'test', db_prefix: 'test' } }),
    resolveAppDbPrefix: () => 'test',
  }));
  vi.doMock('../config/loader', () => ({ getAppsDir: () => appsDir, loadConfig: () => ({ project: { name: 'T', prefix: 'test', db_prefix: 'test' } }) }));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock('../config');
  vi.doUnmock('../config/loader');
});

describe('masked credentials are restored under the write lock', () => {
  it('app library: a rotation that lands first is not reverted by an editor saving the masked read', async () => {
    const { createApp, updateApp, getApp } = await import('../services/app');
    const { getAppTraefik, updateAppTraefik } = await import('../services/traefikConfig');
    const { redactAppTraefik } = await import('../services/traefikRedaction');
    const lib = (hash: string) => ({ middlewares: { gate: { type: 'basicAuth', users: [`alice:${hash}`] } } });
    await createApp({ ...VALID, traefik: lib('OLDHASH') } as any);
    const masked = redactAppTraefik(await getAppTraefik('acme'))!;
    expect(masked.middlewares!.gate).toMatchObject({ users: [`alice:${MASK}`] });

    // Admin rotates while the editor's masked save is in flight.
    await Promise.all([
      updateApp({ ...VALID, traefik: lib('NEWHASH') } as any),
      updateAppTraefik('acme', masked),
    ]);
    expect(((await getApp('acme'))!.traefik!.middlewares!.gate as any).users).toEqual(['alice:NEWHASH']);
  });

  it('tenant overrides: same interleaving keeps the rotated value', async () => {
    const { updateTenantTraefik, getTenantTraefik } = await import('../services/traefikConfig');
    const { redactTenantTraefik } = await import('../services/traefikRedaction');
    const key = 'traefik.http.middlewares.acme-t1-web-x.basicauth.users';
    const body = (hash: string) => ({ raw_labels: { web: { [key]: `dan:${hash}` } } });
    await updateTenantTraefik('acme', 't1', body('OLDHASH'));
    const masked = redactTenantTraefik(await getTenantTraefik('acme', 't1'))!;
    expect(masked.raw_labels!.web[key]).toBe(`dan:${MASK}`);

    await Promise.all([
      updateTenantTraefik('acme', 't1', body('NEWHASH')),
      updateTenantTraefik('acme', 't1', masked),
    ]);
    expect((await getTenantTraefik('acme', 't1'))!.raw_labels!.web[key]).toBe('dan:NEWHASH');
  });
});
