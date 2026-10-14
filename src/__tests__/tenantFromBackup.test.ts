import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

let dataDir = '';
const calls: string[] = [];
const createTenantLocked = vi.fn();
const startCreatedTenantLocked = vi.fn();
const deleteTenantLocked = vi.fn();
const restoreBackupLocked = vi.fn();
vi.mock('../config', () => ({ getDataDir: () => dataDir }));
vi.mock('../services/tenant', () => ({
  createTenantLocked: (...a: unknown[]) => createTenantLocked(...a),
  startCreatedTenantLocked: (...a: unknown[]) => startCreatedTenantLocked(...a),
  deleteTenantLocked: (...a: unknown[]) => deleteTenantLocked(...a),
}));
vi.mock('../services/backup', () => ({ restoreBackupLocked: (...a: unknown[]) => restoreBackupLocked(...a) }));

import { createTenantFromBackup } from '../services/tenantFromBackup';
import { withTenantLock } from '../services/fileLock';

const opts = { tenantId: 't1', domain: 't1.example.com', imageTag: 'v1' };

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tfb-'));
  calls.length = 0;
  for (const m of [createTenantLocked, startCreatedTenantLocked, deleteTenantLocked, restoreBackupLocked]) m.mockReset();
  createTenantLocked.mockImplementation(async () => { calls.push('create'); });
  startCreatedTenantLocked.mockImplementation(async () => { calls.push('start'); });
  deleteTenantLocked.mockImplementation(async () => { calls.push('delete'); });
  restoreBackupLocked.mockResolvedValue({ success: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => { await fs.rm(dataDir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('createTenantFromBackup', () => {
  it('creates stopped, restores, and only then starts (no start before the restore)', async () => {
    restoreBackupLocked.mockImplementation(async () => { calls.push('restore'); return { success: true, warnings: ['w'] }; });
    const r = await createTenantFromBackup('demo', 'abc12345', opts);
    expect(r).toEqual({ success: true, warnings: ['w'] });
    expect(calls).toEqual(['create', 'restore', 'start']);
    expect(createTenantLocked).toHaveBeenCalledWith({ appId: 'demo', tenantId: 't1', domain: 't1.example.com', imageTag: 'v1', start: false });
    expect(restoreBackupLocked).toHaveBeenCalledWith('demo', 'abc12345', 't1', { createNew: true, newDomain: 't1.example.com', containersStopped: true });
    expect(deleteTenantLocked).not.toHaveBeenCalled();
  });

  it('rolls the tenant back when the restore fails, never starting it', async () => {
    restoreBackupLocked.mockResolvedValue({ success: false, error: 'boom', isLocked: true });
    const r = await createTenantFromBackup('demo', 'abc12345', opts);
    expect(r).toMatchObject({ success: false, error: 'boom', isLocked: true });
    expect(deleteTenantLocked).toHaveBeenCalledWith('demo', 't1', false);
    expect(startCreatedTenantLocked).not.toHaveBeenCalled();
  });

  it('rolls back when restore throws, and rethrows', async () => {
    restoreBackupLocked.mockRejectedValue(new Error('crash'));
    await expect(createTenantFromBackup('demo', 'abc12345', opts)).rejects.toThrow('crash');
    expect(deleteTenantLocked).toHaveBeenCalledWith('demo', 't1', false);
    expect(startCreatedTenantLocked).not.toHaveBeenCalled();
  });

  it('rolls back and reports failure when the start fails after a successful restore', async () => {
    startCreatedTenantLocked.mockRejectedValue(new Error('migrator exited 1'));
    const r = await createTenantFromBackup('demo', 'abc12345', opts);
    expect(r.success).toBe(false);
    expect(r.error).toContain('migrator exited 1');
    expect(deleteTenantLocked).toHaveBeenCalledWith('demo', 't1', false);
  });

  it('does not roll back (nothing was created) when createTenant throws', async () => {
    createTenantLocked.mockRejectedValue(Object.assign(new Error('exists'), { status: 409 }));
    await expect(createTenantFromBackup('demo', 'abc12345', opts)).rejects.toThrow('exists');
    expect(deleteTenantLocked).not.toHaveBeenCalled();
    expect(restoreBackupLocked).not.toHaveBeenCalled();
  });

  it('holds the tenant lock for the whole sequence and does not deadlock on it', async () => {
    let waiterRanAt = -1;
    const waiter = new Promise<void>(resolve => {
      // Queued while create-from-backup holds the lock: must run after 'start'.
      setTimeout(() => { void withTenantLock('demo', 't1', async () => { waiterRanAt = calls.length; calls.push('waiter'); resolve(); }); }, 0);
    });
    restoreBackupLocked.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 20));
      calls.push('restore');
      return { success: true };
    });
    const r = await createTenantFromBackup('demo', 'abc12345', opts);
    await waiter;
    expect(r.success).toBe(true);
    expect(calls).toEqual(['create', 'restore', 'start', 'waiter']);
    expect(waiterRanAt).toBe(3);
  }, 10_000);
});
