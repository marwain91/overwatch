import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { secretDataFiles, snapshotDataFiles, bindRepairDataFiles, DATA_FILES } from '../config/dataFiles';

describe('data file registry', () => {
  it('derives the secret (0600) list', () => {
    expect(secretDataFiles()).toEqual([
      'env-vars.json',
      'tenant-env-overrides.json',
      'notification-channels.json',
    ]);
  });

  it('derives the bind-mount repair list', () => {
    expect([...bindRepairDataFiles()].sort()).toEqual([
      'admin-users.json', 'alert-history.jsonl', 'audit.log', 'env-vars.json',
      'notification-channels.json', 'tenant-env-overrides.json',
    ]);
  });

  it('derives the snapshot list: notification channels in, audit log and MCP OAuth state out', () => {
    expect([...snapshotDataFiles()].sort()).toEqual([
      '.schema-versions.json', 'admin-users.json', 'apps.runtime.json', 'apps.trashed.json',
      'env-vars.json', 'notification-channels.json', 'tenant-env-overrides.json',
    ]);
  });

  it('has no duplicate names', () => {
    const names = DATA_FILES.map(f => f.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('config snapshots use the registry', () => {
  afterEach(() => { vi.resetModules(); vi.doUnmock('../config'); });

  it('captures notification-channels.json but not mcp-oauth.json', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-snap-'));
    try {
      await fs.writeFile(path.join(dataDir, 'notification-channels.json'), '[]', { mode: 0o600 });
      await fs.writeFile(path.join(dataDir, 'mcp-oauth.json'), '{}', { mode: 0o600 });
      vi.doMock('../config', () => ({ getDataDir: () => dataDir }));
      const { createSnapshot } = await import('../services/configSnapshots');
      const snap = await createSnapshot('registry');
      expect(snap.files).toContain('notification-channels.json');
      expect(snap.files).not.toContain('mcp-oauth.json');
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
