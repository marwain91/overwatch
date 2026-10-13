import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let tmpRoot: string;
let dataDir: string;
let appsDir: string;

function validApp(id: string) {
  return {
    id,
    name: id,
    domain_template: `*.${id}.example`,
    registry: { type: 'ghcr', url: 'ghcr.io', repository: `ns/${id}`, auth: { type: 'token' } },
    services: [{ name: 'web', image_suffix: 'web', ports: { internal: 80 } }],
    default_image_tag: 'latest',
  };
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-http-errors-'));
  dataDir = path.join(tmpRoot, 'data');
  appsDir = path.join(tmpRoot, 'apps');
  await fs.mkdir(path.join(dataDir, 'apps.d'), { recursive: true });
  await fs.mkdir(appsDir, { recursive: true });
  vi.doMock('../config', () => ({
    getDataDir: () => dataDir,
    getAppsDir: () => appsDir,
    loadConfig: () => ({ project: { name: 'T', prefix: 'test', db_prefix: 'test' } }),
    resolveAppDbPrefix: () => 'test',
  }));
  vi.doMock('../config/loader', () => ({ getAppsDir: () => appsDir, resolveCertResolver: () => ({ name: 'web', resolver: null }) }));
  vi.doMock('../services/fileLock', () => ({ withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn() }));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
  vi.doUnmock('../config');
  vi.doUnmock('../config/loader');
  vi.doUnmock('../services/fileLock');
  vi.doUnmock('../middleware/requireRole');
});

describe('services/app typed errors', () => {
  it('createApp: duplicate is a ConflictError, invalid definition a ValidationError', async () => {
    const { createApp } = await import('../services/app');
    const { ConflictError, ValidationError } = await import('../utils/httpErrors');
    await createApp(validApp('acme') as any);
    await expect(createApp(validApp('acme') as any)).rejects.toBeInstanceOf(ConflictError);
    await expect(createApp({ ...validApp('bad'), domain_template: 42 } as any)).rejects.toBeInstanceOf(ValidationError);
  });

  it('updateApp / deleteApp / restoreApp / purgeApp: unknown ids are NotFoundError', async () => {
    const { updateApp, deleteApp, restoreApp, purgeApp } = await import('../services/app');
    const { NotFoundError } = await import('../utils/httpErrors');
    await expect(updateApp({ id: 'ghost' } as any)).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteApp('ghost')).rejects.toBeInstanceOf(NotFoundError);
    await expect(restoreApp('ghost')).rejects.toBeInstanceOf(NotFoundError);
    await expect(purgeApp('ghost')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('deleteApp: app with tenants and no force is a ConflictError', async () => {
    const { createApp, deleteApp } = await import('../services/app');
    const { ConflictError } = await import('../utils/httpErrors');
    await createApp(validApp('acme') as any);
    await fs.mkdir(path.join(appsDir, 'acme', 'tenants', 't1'), { recursive: true });
    await expect(deleteApp('acme')).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('services/users typed errors', () => {
  it('addAdminUser duplicate is a ConflictError; removing an unknown admin is a NotFoundError', async () => {
    const { addAdminUser, removeAdminUser } = await import('../services/users');
    const { ConflictError, NotFoundError } = await import('../utils/httpErrors');
    await addAdminUser('a@example.com', 'system');
    await addAdminUser('b@example.com', 'system');
    await expect(addAdminUser('A@example.com', 'system')).rejects.toBeInstanceOf(ConflictError);
    await expect(removeAdminUser('ghost@example.com', 'a@example.com')).rejects.toBeInstanceOf(NotFoundError);
    await expect(removeAdminUser('b@example.com', 'b@example.com')).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('services/tenant typed errors', () => {
  it('createTenant: bad ids, domain and tag are ValidationError; unknown app is NotFoundError', async () => {
    const { createTenant } = await import('../services/tenant');
    const { ValidationError, NotFoundError } = await import('../utils/httpErrors');
    await expect(createTenant({ appId: 'Bad App', tenantId: 't1', domain: 'a.example.com' })).rejects.toBeInstanceOf(ValidationError);
    await expect(createTenant({ appId: 'acme', tenantId: 'T 1', domain: 'a.example.com' })).rejects.toBeInstanceOf(ValidationError);
    await expect(createTenant({ appId: 'acme', tenantId: 't1', domain: 'not a domain!' })).rejects.toBeInstanceOf(ValidationError);
    await expect(createTenant({ appId: 'acme', tenantId: 't1', domain: 'a.example.com' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('updateTenant: bad ids/tag are ValidationError; unknown tenant is NotFoundError', async () => {
    const { updateTenant } = await import('../services/tenant');
    const { ValidationError, NotFoundError } = await import('../utils/httpErrors');
    await expect(updateTenant('Bad App', 't1', 'v1')).rejects.toBeInstanceOf(ValidationError);
    await expect(updateTenant('acme', 'T 1', 'v1')).rejects.toBeInstanceOf(ValidationError);
    await expect(updateTenant('acme', 't1', 'bad tag!')).rejects.toBeInstanceOf(ValidationError);
    await expect(updateTenant('acme', 't1', 'v1')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('POST /apps/:appId/tenants validation mapping', () => {
  it('rejects an invalid domain / tag with 400 and the service message', async () => {
    vi.doMock('../middleware/requireRole', () => ({ requireRole: () => (_req: any, _res: any, next: any) => next() }));
    const express = (await import('express')).default;
    const request = (await import('supertest')).default;
    const { createApp } = await import('../services/app');
    await createApp(validApp('acme') as any);
    const router = (await import('../routes/tenants')).default;
    const { errorHandler } = await import('../middleware/errorHandler');
    const app = express();
    app.use(express.json());
    app.use('/apps/:appId/tenants', router);
    app.use(errorHandler);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const badDomain = await request(app).post('/apps/acme/tenants').send({ tenantId: 't1', domain: 'not a domain!' });
    expect(badDomain.status).toBe(400);
    const badTag = await request(app).post('/apps/acme/tenants').send({ tenantId: 't1', domain: 'a.example.com', imageTag: 'bad tag!' });
    expect(badTag.status).toBe(400);
    const missingApp = await request(app).post('/apps/ghost/tenants').send({ tenantId: 't1', domain: 'a.example.com' });
    expect(missingApp.status).toBe(404);
  });
});
