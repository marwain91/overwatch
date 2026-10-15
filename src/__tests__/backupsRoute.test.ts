import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const svc = vi.hoisted(() => ({
  DEFAULT_RETENTION: { keepDaily: 7, keepWeekly: 4, keepMonthly: 12 },
  initializeRepository: vi.fn(),
  unlockRepository: vi.fn(),
  createBackup: vi.fn(),
  backupAllTenants: vi.fn(),
  restoreBackup: vi.fn(),
  deleteSnapshot: vi.fn(),
  pruneBackups: vi.fn(),
}));

vi.mock('../services/backup', () => svc);
vi.mock('../services/backupCache', () => ({ getBackupInfoCached: vi.fn(), listSnapshotsCached: vi.fn() }));
vi.mock('../services/app', () => ({ getApp: vi.fn() }));
vi.mock('../services/tenantFromBackup', () => ({ createTenantFromBackup: vi.fn() }));
vi.mock('../services/docker', () => ({ getTenantInfo: vi.fn(async (appId: string, tenantId: string) => ({ appId, tenantId })) }));
vi.mock('../middleware/requireRole', () => ({ requireRole: () => (_req: any, _res: any, next: any) => next() }));

async function mount() {
  const { default: router } = await import('../routes/backups');
  const { errorHandler } = await import('../middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use('/api/apps/:appId/backups', router);
  app.use(errorHandler);
  return app;
}

// The first import of the route graph is slow on a loaded host.
beforeAll(async () => { await mount(); }, 60_000);

beforeEach(() => {
  for (const fn of Object.values(svc)) if (typeof fn === 'function') fn.mockReset();
  svc.pruneBackups.mockResolvedValue({ success: true });
});

describe('POST /backups/prune', () => {
  const prune = async (body: unknown) => request(await mount()).post('/api/apps/shop/backups/prune').send(body as object);

  it('uses the defaults for omitted values', async () => {
    await prune({}).then(r => expect(r.status).toBe(200));
    expect(svc.pruneBackups).toHaveBeenCalledWith('shop', { keepDaily: 7, keepWeekly: 4, keepMonthly: 12 }, { dryRun: false });
  });

  it('keeps an explicit 0 instead of turning it into the default', async () => {
    await prune({ keepDaily: 3, keepWeekly: 0, keepMonthly: 0 }).then(r => expect(r.status).toBe(200));
    expect(svc.pruneBackups).toHaveBeenCalledWith('shop', { keepDaily: 3, keepWeekly: 0, keepMonthly: 0 }, { dryRun: false });
  });

  it.each([
    [{ keepDaily: -1 }],
    [{ keepWeekly: 1.5 }],
    [{ keepMonthly: 'lots' }],
    [{ keepDaily: 366 }],
  ])('rejects %j', async (body) => {
    const r = await prune(body);
    expect(r.status).toBe(400);
    expect(svc.pruneBackups).not.toHaveBeenCalled();
  });

  it('refuses a policy that keeps nothing', async () => {
    const r = await prune({ keepDaily: 0, keepWeekly: 0, keepMonthly: 0 });
    expect(r.status).toBe(400);
    expect(svc.pruneBackups).not.toHaveBeenCalled();
  });

  it('passes dryRun through and returns the plan', async () => {
    svc.pruneBackups.mockResolvedValue({ success: true, dryRun: true, remove: [{ id: 'a' }], removeCount: 1, keepCount: 2 });
    const r = await prune({ dryRun: true });
    expect(svc.pruneBackups).toHaveBeenCalledWith('shop', expect.anything(), { dryRun: true });
    expect(r.body).toMatchObject({ dryRun: true, removeCount: 1, keepCount: 2, remove: [{ id: 'a' }] });
  });
});

describe('POST /backups/unlock', () => {
  beforeEach(() => { svc.unlockRepository.mockResolvedValue({ success: true }); });

  it('removes stale locks only unless force is true', async () => {
    const app = await mount();
    await request(app).post('/api/apps/shop/backups/unlock').send({}).expect(200);
    expect(svc.unlockRepository).toHaveBeenLastCalledWith('shop', { force: false });
    await request(app).post('/api/apps/shop/backups/unlock').send({ force: 'yes' }).expect(200);
    expect(svc.unlockRepository).toHaveBeenLastCalledWith('shop', { force: false });
    await request(app).post('/api/apps/shop/backups/unlock').send({ force: true }).expect(200);
    expect(svc.unlockRepository).toHaveBeenLastCalledWith('shop', { force: true });
  });
});

describe('POST /backups (create)', () => {
  const create = async () => request(await mount()).post('/api/apps/shop/backups').send({ tenantId: 't1' });

  it('reports an incomplete backup and its missing paths', async () => {
    svc.createBackup.mockResolvedValue({ success: true, snapshotId: 'abc', incomplete: true, missingPaths: ['web:/data'] });
    const r = await create();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, snapshotId: 'abc', incomplete: true, missingPaths: ['web:/data'] });
  });

  it('answers 409 when the tenant is busy', async () => {
    svc.createBackup.mockResolvedValue({ success: false, busy: true, error: "Tenant 'shop/t1' is busy" });
    const r = await create();
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/busy/);
  });
});

describe('POST /backups/:snapshotId/restore', () => {
  const SNAP = 'abcdef12';
  const restore = async (body: Record<string, unknown>, confirm?: string) => {
    const req = request(await mount()).post(`/api/apps/shop/backups/${SNAP}/restore`);
    if (confirm !== undefined) req.set('X-Confirm-Id', confirm);
    return req.send(body);
  };

  beforeEach(() => { svc.restoreBackup.mockResolvedValue({ success: true, safetySnapshotId: 'f'.repeat(64) }); });

  // Restore overwrites the live data of the target tenant, like a delete.
  it('requires the target tenant id as confirmation', async () => {
    const r = await restore({ tenantId: 't1' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/X-Confirm-Id/);
    expect(svc.restoreBackup).not.toHaveBeenCalled();
  });

  it('refuses a confirmation of another tenant', async () => {
    expect((await restore({ tenantId: 't1' }, 't2')).status).toBe(400);
    expect((await restore({ tenantId: 't1' }, SNAP)).status).toBe(400);
    expect(svc.restoreBackup).not.toHaveBeenCalled();
  });

  it('restores with the header or a confirmId body field', async () => {
    const r = await restore({ tenantId: 't1' }, 't1');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, safetySnapshotId: 'f'.repeat(64) });
    expect(svc.restoreBackup).toHaveBeenLastCalledWith('shop', SNAP, 't1', { allowCrossTenant: false });
    expect((await restore({ tenantId: 't1', confirmId: 't1' })).status).toBe(200);
  });

  it('passes an explicit cross-tenant choice through', async () => {
    await restore({ tenantId: 't1', allowCrossTenant: true }, 't1');
    expect(svc.restoreBackup).toHaveBeenLastCalledWith('shop', SNAP, 't1', { allowCrossTenant: true });
    await restore({ tenantId: 't1', allowCrossTenant: 'true' }, 't1');
    expect(svc.restoreBackup).toHaveBeenLastCalledWith('shop', SNAP, 't1', { allowCrossTenant: false });
  });

  it('reports the safety snapshot and whether it was put back on failure', async () => {
    svc.restoreBackup.mockResolvedValue({ success: false, error: 'Restore failed: x', safetySnapshotId: 'f'.repeat(64), rolledBack: true });
    const r = await restore({ tenantId: 't1' }, 't1');
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ error: 'Restore failed: x', safetySnapshotId: 'f'.repeat(64), rolledBack: true });
  });
});
