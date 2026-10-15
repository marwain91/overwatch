import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tenantAppDefMock } from './tenantAppDefMock';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let tmpRoot: string;
beforeEach(async () => { tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-app-rollback-')); });
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
  for (const m of ['child_process', '../config', '../config/loader', '../services/app', '../services/envVars', '../services/docker',
    '../services/manifestExtractor', '../services/tenantAppDef', '../services/tenantTraefik', '../services/fileLock']) vi.doUnmock(m);
});

const TS = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
const shop = () => ({
  id: 'shop', name: 'Shop', domain_template: '*.shop.test',
  registry: { type: 'ghcr', url: 'ghcr.io', repository: 'acme/shop', auth: { type: 'token' } },
  services: [{ name: 'backend', image_suffix: 'backend', required: true, is_init_container: false, ports: { internal: 3000 } }],
  default_image_tag: '1.0.0',
}) as any;

async function setup() {
  const appsDir = path.join(tmpRoot, 'apps');
  for (const t of ['tenant-one', 'tenant-two']) {
    const dir = path.join(appsDir, 'shop', 'tenants', t);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, '.env'), `APP_ID=shop\nTENANT_ID=${t}\nTENANT_DOMAIN=${t}.shop.test\nIMAGE_TAG=1.0.0\n`, { mode: 0o600 });
    await fs.writeFile(path.join(dir, 'docker-compose.yml'), 'services:\n  backend:\n    image: old\n');
  }
  let globalStatic: any = shop();
  const original = JSON.parse(JSON.stringify(globalStatic));
  // Real applyApp parses with Zod; keep the stored value equal to what was applied.
  const applyApp = vi.fn(async (def: any) => { globalStatic = JSON.parse(JSON.stringify(def)); return { result: 'updated', app: { ...globalStatic, ...TS }, changedKeys: ['env_vars'] }; });
  const manifests: Record<string, any> = {
    a: { ...shop(), env_vars: [{ key: 'FROM_A' }] },
    b: { ...shop(), env_vars: [{ key: 'FROM_B' }] },
  };
  // Tenant one's first `up` blocks until released, then fails.
  let releaseUp!: () => void;
  const upGate = new Promise<void>(r => { releaseUp = r; });
  let upReached!: () => void;
  const upBlocked = new Promise<void>(r => { upReached = r; });
  let failedOnce = false;

  vi.doMock('../services/fileLock', () => ({
    withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn(),
    withTenantLock: <T>(_a: string, _t: string, fn: () => Promise<T>) => fn(),
  }));
  vi.doMock('../config', () => ({
    loadConfig: () => ({
      project: { name: 'Test', prefix: 'test', db_prefix: 'test' },
      database: { type: 'mariadb', host: 'db', port: 3306 },
      networking: { external_network: 'test-network' },
      traefik: { log_level: 'INFO', tls_termination: 'upstream', upstream_entrypoint: 'web' },
    }),
    getAppsDir: () => appsDir,
    resolveAppDbPrefix: () => 'test',
  }));
  vi.doMock('../config/loader', () => ({ resolveCertResolver: () => ({ name: 'web', resolver: null }) }));
  vi.doMock('../services/app', () => ({ getApp: vi.fn(async () => ({ ...globalStatic, ...TS })), applyApp }));
  vi.doMock('../services/envVars', () => ({ generateSharedEnvFile: vi.fn(async () => undefined), deleteTenantAllOverrides: vi.fn() }));
  vi.doMock('../services/manifestExtractor', () => ({
    readManifestFromAppImage: vi.fn(async (_app: any, tag: string) => manifests[tag]),
    resolveManifestImageRef: vi.fn((_a: any, tag: string) => `ghcr.io/acme/shop/backend:${tag}`),
  }));
  vi.doMock('../services/tenantTraefik', () => ({ readTenantTraefik: vi.fn(async () => undefined) }));
  vi.doMock('../services/tenantAppDef', () => tenantAppDefMock({
    readTenantAppDef: vi.fn(async () => ({ ...shop(), ...TS })),
    writeTenantAppDef: vi.fn(async () => undefined),
  }));
  vi.doMock('../services/docker', () => ({ ensureExternalVolumes: vi.fn(async () => undefined) }));
  const execFile = vi.fn((_cmd: string, args: string[], _opts: unknown, cb: (err: any, stdout: string, stderr: string) => void) => {
    const dir = args[args.indexOf('--project-directory') + 1] ?? '';
    if (args.includes('up') && dir.endsWith('tenant-one') && !failedOnce) {
      failedOnce = true;
      upReached();
      void upGate.then(() => cb(Object.assign(new Error('up failed'), { stderr: 'Error: up failed' }), '', 'Error: up failed'));
    } else {
      cb(null, '', '');
    }
    return { on: () => {} };
  });
  vi.doMock('child_process', () => ({ execFile }));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { updateTenant } = await import('../services/tenant');
  return { updateTenant, applyApp, original, current: () => globalStatic, warn, releaseUp, upBlocked };
}

describe('updateTenant rollback of the global app definition', () => {
  it('restores the previous definition when nothing changed it since this update applied it', async () => {
    const s = await setup();
    const update = s.updateTenant('shop', 'tenant-one', 'a');
    const settled = update.catch(e => e);
    await s.upBlocked;
    s.releaseUp();
    await settled;
    expect(s.applyApp).toHaveBeenCalledTimes(2);
    expect(s.current()).toEqual(s.original);
  });

  it('leaves a definition another update applied in the meantime', async () => {
    const s = await setup();
    const first = s.updateTenant('shop', 'tenant-one', 'a').catch(e => e);
    await s.upBlocked;
    await s.updateTenant('shop', 'tenant-two', 'b'); // interleaves and succeeds
    expect(s.current().env_vars.map((v: any) => v.key)).toEqual(['FROM_B']);
    s.releaseUp();
    const err: any = await first;
    expect(err.message).toMatch(/up failed/);
    expect(s.current().env_vars.map((v: any) => v.key)).toEqual(['FROM_B']);
    expect(s.applyApp).toHaveBeenCalledTimes(2); // a, b — no rollback write
    expect(s.warn).toHaveBeenCalledWith('[tenant] skipped app-definition rollback: changed concurrently');
  });
});
