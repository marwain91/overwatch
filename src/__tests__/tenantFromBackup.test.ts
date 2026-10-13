import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: string[] = [];
const createTenant = vi.fn();
const deleteTenant = vi.fn();
const restartTenant = vi.fn();
const restoreBackup = vi.fn();
const testConnection = vi.fn();
vi.mock('../services/app', () => ({ getApp: async () => ({ id: 'demo', db_prefix: 'x' }) }));
vi.mock('../services/tenant', () => ({
  createTenant: (...a: unknown[]) => createTenant(...a),
  deleteTenant: (...a: unknown[]) => deleteTenant(...a),
}));
vi.mock('../services/docker', () => ({ restartTenant: (...a: unknown[]) => restartTenant(...a) }));
vi.mock('../services/backup', () => ({ restoreBackup: (...a: unknown[]) => restoreBackup(...a) }));
vi.mock('../adapters/database', () => ({ getDatabaseAdapter: () => ({ testConnection }) }));

import { createTenantFromBackup } from '../services/tenantFromBackup';

const opts = { tenantId: 't1', domain: 't1.example.com', imageTag: 'v1', dbReadyTimeoutMs: 50, dbPollIntervalMs: 1 };

beforeEach(() => {
  calls.length = 0;
  for (const m of [createTenant, deleteTenant, restartTenant, restoreBackup, testConnection]) m.mockReset();
  createTenant.mockImplementation(async () => { calls.push('create'); });
  deleteTenant.mockImplementation(async () => { calls.push('delete'); });
  restartTenant.mockImplementation(async () => { calls.push('restart'); });
  testConnection.mockResolvedValue(true);
});

describe('createTenantFromBackup', () => {
  it('creates, waits for the DB, restores, then restarts', async () => {
    restoreBackup.mockImplementation(async () => { calls.push('restore'); return { success: true, warnings: ['w'] }; });
    const r = await createTenantFromBackup('demo', 'abc12345', opts);
    expect(r).toEqual({ success: true, warnings: ['w'] });
    expect(calls).toEqual(['create', 'restore', 'restart']);
    expect(restoreBackup).toHaveBeenCalledWith('demo', 'abc12345', 't1', { createNew: true, newDomain: 't1.example.com' });
    expect(createTenant).toHaveBeenCalledWith({ appId: 'demo', tenantId: 't1', domain: 't1.example.com', imageTag: 'v1' });
  });

  it('polls until the DB answers instead of sleeping a fixed time', async () => {
    testConnection.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
    restoreBackup.mockResolvedValue({ success: true });
    await createTenantFromBackup('demo', 'abc12345', opts);
    expect(testConnection).toHaveBeenCalledTimes(3);
  });

  it('rolls the tenant back when the restore fails and returns the failure', async () => {
    restoreBackup.mockResolvedValue({ success: false, error: 'boom', isLocked: true });
    const r = await createTenantFromBackup('demo', 'abc12345', opts);
    expect(r).toMatchObject({ success: false, error: 'boom', isLocked: true });
    expect(deleteTenant).toHaveBeenCalledWith('demo', 't1', false);
  });

  it('rolls back when restore throws, and rethrows', async () => {
    restoreBackup.mockRejectedValue(new Error('crash'));
    await expect(createTenantFromBackup('demo', 'abc12345', opts)).rejects.toThrow('crash');
    expect(deleteTenant).toHaveBeenCalledWith('demo', 't1', false);
  });

  it('rolls back when the DB never becomes ready, without restoring', async () => {
    testConnection.mockResolvedValue(false);
    const r = await createTenantFromBackup('demo', 'abc12345', opts);
    expect(r.success).toBe(false);
    expect(restoreBackup).not.toHaveBeenCalled();
    expect(deleteTenant).toHaveBeenCalledWith('demo', 't1', false);
  });

  it('does not roll back (nothing was created) when createTenant throws', async () => {
    createTenant.mockRejectedValue(Object.assign(new Error('exists'), { status: 409 }));
    await expect(createTenantFromBackup('demo', 'abc12345', opts)).rejects.toThrow('exists');
    expect(deleteTenant).not.toHaveBeenCalled();
  });

  it('keeps success when the final restart fails', async () => {
    restoreBackup.mockResolvedValue({ success: true });
    restartTenant.mockRejectedValue(new Error('x'));
    const r = await createTenantFromBackup('demo', 'abc12345', opts);
    expect(r.success).toBe(true);
    expect(deleteTenant).not.toHaveBeenCalled();
    expect(r.warnings?.length).toBe(1);
  });
});
