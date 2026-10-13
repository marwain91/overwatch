import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as util from 'util';

/** execFile mock whose promisified form resolves `{stdout, stderr}` like Node's. */
function withPromisify(
  mock: (cmd: string, args: string[], cb: (err: any, stdout: string, stderr: string) => void) => void,
) {
  const fn = vi.fn(mock) as any;
  fn[util.promisify.custom] = (cmd: string, args: string[]) =>
    new Promise((resolve, reject) => {
      fn(cmd, args, (err: any, stdout: string, stderr: string) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });
  return fn;
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-manifest-policy-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('child_process');
  vi.doUnmock('../config');
  vi.doUnmock('../config/loader');
  vi.doUnmock('../services/app');
  vi.doUnmock('../services/envVars');
  vi.doUnmock('../services/docker');
  vi.doUnmock('../services/manifestExtractor');
  vi.doUnmock('../services/tenantAppDef');
  vi.doUnmock('../services/tenantTraefik');
});

const TIMESTAMPS = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

function shopStatic() {
  return {
    id: 'shop',
    name: 'Shop',
    domain_template: '*.shop.test',
    registry: { type: 'ghcr', url: 'ghcr.io', repository: 'acme/shop', auth: { type: 'token' } },
    services: [{
      name: 'backend',
      image_suffix: 'backend',
      required: true,
      is_init_container: false,
      ports: { internal: 3000 },
      volumes: [{ name: 'uploads', container_path: '/app/uploads' }],
    }],
    admin_access: {
      enabled: true,
      url_template: 'https://${domain}/admin-login#token=${token}',
      secret_env: 'AUTH_SERVICE_SECRET',
    },
    default_image_tag: '1.0.0',
  } as any;
}

describe('updateTenant manifest allowlist', () => {
  it('keeps admin_access.secret_env and volumes the image manifest tries to change', async () => {
    const appsDir = path.join(tmpRoot, 'apps');
    const tenantPath = path.join(appsDir, 'shop', 'tenants', 'tenant-one');
    await fs.mkdir(tenantPath, { recursive: true });
    const sharedEnvPath = path.join(tenantPath, 'shared.env');
    const composePath = path.join(tenantPath, 'docker-compose.yml');
    await fs.writeFile(
      path.join(tenantPath, '.env'),
      'APP_ID=shop\nTENANT_ID=tenant-one\nTENANT_DOMAIN=tenant-one.shop.test\nIMAGE_TAG=1.0.0\n',
      { mode: 0o600 },
    );
    await fs.writeFile(sharedEnvPath, 'SHARED=1\n', { mode: 0o600 });
    await fs.writeFile(composePath, 'services:\n  backend:\n    image: old\n');

    const globalApp = { ...shopStatic(), ...TIMESTAMPS };
    const imageManifest = shopStatic();
    imageManifest.admin_access.secret_env = 'JWT_SECRET';
    imageManifest.services[0].volumes.push({ name: 'host-root', container_path: '/host', name_template: '/', external: true });
    // An allowed change that must still go through.
    imageManifest.services[0].health_check = { type: 'http', path: '/healthz' };
    imageManifest.env_vars = [{ key: 'SMTP_HOST', description: 'SMTP relay' }];

    // Stateful snapshot so the regenerated compose reflects what was written.
    let tenantSnapshot: any = globalApp;
    const writeTenantAppDef = vi.fn(async (_appId: string, _tenantId: string, staticDef: any) => {
      tenantSnapshot = { ...staticDef, ...TIMESTAMPS };
    });
    const applyApp = vi.fn(async (staticDef: any) => ({
      result: 'updated',
      app: { ...staticDef, ...TIMESTAMPS },
      changedKeys: ['services', 'env_vars'],
    }));

    vi.doMock('../config', () => ({
      loadConfig: () => ({
        project: { name: 'Test', prefix: 'test', db_prefix: 'test' },
        database: { type: 'mariadb', host: 'db', port: 3306, root_user: 'root', root_password_env: 'MYSQL_ROOT_PASSWORD', container_name: 'db' },
        networking: { external_network: 'test-network', internal_network_template: '${prefix}-${tenantId}-internal', apps_path: '/app/apps' },
        traefik: { log_level: 'INFO', tls_termination: 'upstream', upstream_entrypoint: 'web' },
      }),
      getAppsDir: () => appsDir,
      resolveAppDbPrefix: () => 'test',
    }));
    vi.doMock('../config/loader', () => ({ resolveCertResolver: () => ({ name: 'web', resolver: null }) }));
    vi.doMock('../services/app', () => ({
      getApp: vi.fn(async (id: string) => id === 'shop' ? globalApp : null),
      applyApp,
    }));
    vi.doMock('../services/envVars', () => ({
      generateSharedEnvFile: vi.fn(async () => undefined),
      deleteTenantAllOverrides: vi.fn(),
    }));
    vi.doMock('../services/manifestExtractor', () => ({
      readManifestFromAppImage: vi.fn(async () => imageManifest),
      resolveManifestImageRef: vi.fn(() => 'ghcr.io/acme/shop/backend:1.2.0'),
    }));
    vi.doMock('../services/tenantTraefik', () => ({ readTenantTraefik: vi.fn(async () => undefined) }));
    vi.doMock('../services/tenantAppDef', () => ({
      readTenantAppDef: vi.fn(async () => tenantSnapshot),
      writeTenantAppDef,
    }));
    vi.doMock('../services/docker', () => ({ ensureExternalVolumes: vi.fn(async () => undefined) }));
    vi.doMock('child_process', () => ({
      execFile: withPromisify((_cmd, _args, cb) => cb(null, '', '')),
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { eventBus } = await import('../services/eventBus');
    const progress: any[] = [];
    const onProgress = (p: any) => progress.push(p);
    eventBus.on('tenant:update:progress', onProgress);
    try {
      const { updateTenant } = await import('../services/tenant');
      await updateTenant('shop', 'tenant-one', '1.2.0');
    } finally {
      eventBus.off('tenant:update:progress', onProgress);
    }

    expect(applyApp).toHaveBeenCalledTimes(1);
    const applied = applyApp.mock.calls[0][0];
    expect(applied.admin_access.secret_env).toBe('AUTH_SERVICE_SECRET');
    expect(applied.services[0].volumes).toEqual([{ name: 'uploads', container_path: '/app/uploads' }]);
    expect(applied.services[0].health_check).toEqual(expect.objectContaining({ path: '/healthz' }));
    expect(applied.env_vars).toEqual([expect.objectContaining({ key: 'SMTP_HOST' })]);

    expect(writeTenantAppDef).toHaveBeenCalledTimes(1);
    expect(writeTenantAppDef.mock.calls[0][2]).toEqual(applied);

    const compose = await fs.readFile(composePath, 'utf-8');
    expect(compose).toContain(':/app/uploads');
    expect(compose).not.toContain(':/host');

    expect(warn).toHaveBeenCalledWith(expect.stringContaining(
      '[manifest] ignored protected fields from image 1.2.0: admin_access, services.backend.volumes',
    ));
    expect(progress).toContainEqual(expect.objectContaining({
      step: 'manifest',
      status: 'completed',
      detail: expect.stringContaining('ignored protected fields: admin_access, services.backend.volumes'),
    }));
  });
});
