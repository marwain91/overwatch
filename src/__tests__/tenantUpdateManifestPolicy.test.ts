import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tenantAppDefMock } from './tenantAppDefMock';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { HttpError } from '../utils/httpErrors';

/** execFile mock with Node's `(cmd, args, opts, cb)` signature, as runDocker calls it. */
function withPromisify(
  mock: (cmd: string, args: string[], cb: (err: any, stdout: string, stderr: string) => void) => void,
) {
  return vi.fn((cmd: string, args: string[], _opts: unknown, cb: (err: any, stdout: string, stderr: string) => void) => {
    mock(cmd, args, cb);
    return { on: () => {} };
  });
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

const ORIGINAL_ENV = 'APP_ID=shop\nTENANT_ID=tenant-one\nTENANT_DOMAIN=tenant-one.shop.test\nIMAGE_TAG=1.0.0\n';
const ORIGINAL_COMPOSE = 'services:\n  backend:\n    image: old\n';

/**
 * Run updateTenant for tenant-one of `shop` against `imageManifest`, with the
 * global definition and the tenant snapshot both equal to `appStatic`.
 * The error updateTenant throws, if any, is returned rather than rethrown.
 */
async function runUpdate(imageManifest: any, appStatic: any = shopStatic()) {
  const appsDir = path.join(tmpRoot, 'apps');
  const tenantPath = path.join(appsDir, 'shop', 'tenants', 'tenant-one');
  await fs.mkdir(tenantPath, { recursive: true });
  const composePath = path.join(tenantPath, 'docker-compose.yml');
  const envPath = path.join(tenantPath, '.env');
  await fs.writeFile(envPath, ORIGINAL_ENV, { mode: 0o600 });
  await fs.writeFile(path.join(tenantPath, 'shared.env'), 'SHARED=1\n', { mode: 0o600 });
  await fs.writeFile(composePath, ORIGINAL_COMPOSE);

  let globalApp: any = { ...appStatic, ...TIMESTAMPS };
  // Stateful snapshot so the regenerated compose reflects what was written.
  let tenantSnapshot: any = globalApp;
  const writeTenantAppDef = vi.fn(async (_appId: string, _tenantId: string, staticDef: any) => {
    tenantSnapshot = { ...staticDef, ...TIMESTAMPS };
  });
  // Stateful like the real store: the rollback only restores what this update applied.
  const applyApp = vi.fn(async (staticDef: any) => {
    globalApp = { ...staticDef, ...TIMESTAMPS };
    return { result: 'updated', app: globalApp, changedKeys: ['services'] };
  });

  vi.doMock('../services/fileLock', () => ({ withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn(), withTenantLock: <T>(_a: string, _t: string, fn: () => Promise<T>) => fn() }));

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
  vi.doMock('../services/envVars', async () => ({
    ...(await vi.importActual<object>('../services/envVars')),
    generateSharedEnvFile: vi.fn(async () => undefined),
    deleteTenantAllOverrides: vi.fn(),
  }));
  vi.doMock('../services/manifestExtractor', () => ({
    readManifestFromAppImage: vi.fn(async () => imageManifest),
    resolveManifestImageRef: vi.fn(() => 'ghcr.io/acme/shop/backend:1.2.0'),
  }));
  vi.doMock('../services/tenantTraefik', () => ({ readTenantTraefik: vi.fn(async () => undefined) }));
  vi.doMock('../services/tenantAppDef', () => tenantAppDefMock({
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
  const callbackProgress: any[] = [];
  const onProgress = (p: any) => progress.push(p);
  eventBus.on('tenant:update:progress', onProgress);
  let error: unknown;
  try {
    const { updateTenant } = await import('../services/tenant');
    await updateTenant('shop', 'tenant-one', '1.2.0', (p: any) => callbackProgress.push(p));
  } catch (err) {
    error = err;
  } finally {
    eventBus.off('tenant:update:progress', onProgress);
  }

  return {
    error,
    applyApp,
    writeTenantAppDef,
    warn,
    progress,
    callbackProgress,
    compose: await fs.readFile(composePath, 'utf-8'),
    env: await fs.readFile(envPath, 'utf-8'),
  };
}

describe('updateTenant manifest allowlist', () => {
  it('reports progress to the onProgress callback as well as the global bus', async () => {
    const { error, progress, callbackProgress } = await runUpdate(shopStatic());
    expect(error).toBeUndefined();
    expect(callbackProgress.length).toBeGreaterThan(0);
    expect(callbackProgress).toEqual(progress);
    expect(callbackProgress).toContainEqual(expect.objectContaining({ step: 'done', status: 'completed' }));
  });

  it('keeps admin_access.secret_env and volumes the image manifest tries to change', async () => {
    const imageManifest = shopStatic();
    imageManifest.admin_access.secret_env = 'JWT_SECRET';
    imageManifest.services[0].volumes.push({ name: 'host-root', container_path: '/host', name_template: '/', external: true });
    // An allowed change that must still go through.
    imageManifest.services[0].health_check = { type: 'http', path: '/healthz' };
    imageManifest.env_vars = [{ key: 'SMTP_HOST', description: 'SMTP relay' }];

    const { error, applyApp, writeTenantAppDef, warn, progress, compose } = await runUpdate(imageManifest);

    expect(error).toBeUndefined();
    expect(applyApp).toHaveBeenCalledTimes(1);
    const applied = applyApp.mock.calls[0][0];
    expect(applied.admin_access.secret_env).toBe('AUTH_SERVICE_SECRET');
    expect(applied.services[0].volumes).toEqual([{ name: 'uploads', container_path: '/app/uploads' }]);
    expect(applied.services[0].health_check).toEqual(expect.objectContaining({ path: '/healthz' }));
    expect(applied.env_vars).toEqual([expect.objectContaining({ key: 'SMTP_HOST' })]);

    expect(writeTenantAppDef).toHaveBeenCalledTimes(1);
    expect(writeTenantAppDef.mock.calls[0][2]).toEqual(applied);

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

  it('ignores a middleware the manifest adds to its own library and a route, and still updates', async () => {
    const imageManifest = shopStatic();
    imageManifest.traefik = { middlewares: { 'open-cors': { type: 'headers', custom_response_headers: { 'Access-Control-Allow-Origin': '*' } } } };
    imageManifest.services[0].routing = { path_prefix: '/api', middlewares: ['open-cors'] };

    const { error, applyApp, progress, compose } = await runUpdate(imageManifest);

    expect(error).toBeUndefined();
    const applied = applyApp.mock.calls[0][0];
    expect(applied).not.toHaveProperty('traefik');
    expect(applied.services[0].routing).toEqual({ enabled: true, strip_prefix: false, path_prefix: '/api' });
    expect(compose).toContain('PathPrefix(`/api`)');
    expect(compose).not.toContain('open-cors');
    expect(progress).toContainEqual(expect.objectContaining({
      step: 'manifest',
      status: 'completed',
      detail: expect.stringContaining('ignored protected fields: traefik, services.backend.routing.middlewares'),
    }));
    expect(progress).toContainEqual(expect.objectContaining({ step: 'done', status: 'completed' }));
  });

  it('fails at the config step, rolls back and names a middleware the library lacks', async () => {
    // An admin edit left the route pointing at a middleware the app library
    // does not define; the image only changes an allowed field.
    const appStatic = shopStatic();
    appStatic.services[0].routing = { path_prefix: '/api', middlewares: ['api-auth'] };
    const imageManifest = shopStatic();
    imageManifest.services[0].routing = { path_prefix: '/api', middlewares: ['api-auth'] };
    imageManifest.services[0].health_check = { type: 'http', path: '/healthz' };

    const { error, applyApp, writeTenantAppDef, progress, compose, env } = await runUpdate(imageManifest, appStatic);

    // Same module registry as the tenant service, so instanceof holds.
    const { HttpError: HttpErrorClass } = await import('../utils/httpErrors');
    expect(error).toBeInstanceOf(HttpErrorClass);
    expect((error as HttpError).status).toBe(500);
    expect((error as HttpError).expose).toBe(true);
    expect((error as HttpError).clientMessage).toBe(
      'Middleware "api-auth" referenced by shop/tenant-one/backend is not defined in app.traefik.middlewares or traefik.middlewares',
    );
    expect(progress).toContainEqual(expect.objectContaining({
      step: 'config',
      status: 'failed',
      detail: expect.stringContaining('Middleware "api-auth"'),
    }));
    expect(progress.some(p => p.step === 'pull')).toBe(false);

    // The manifest was applied, then both definitions and the tenant files were restored.
    expect(applyApp.mock.calls[0][0].services[0].health_check).toEqual(expect.objectContaining({ path: '/healthz' }));
    expect(writeTenantAppDef).toHaveBeenLastCalledWith('shop', 'tenant-one', appStatic);
    expect(applyApp).toHaveBeenLastCalledWith(appStatic, 'rollback:shop/tenant-one');
    expect(env).toBe(ORIGINAL_ENV);
    expect(compose).toBe(ORIGINAL_COMPOSE);
  });
});
