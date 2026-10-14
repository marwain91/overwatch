import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

let appDef: any;

vi.mock('../services/app', () => ({ getApp: vi.fn(async () => appDef) }));
vi.mock('../services/backupCache', () => ({
  getBackupInfoCached: vi.fn(async () => ({ configured: true, initialized: true })),
  listSnapshotsCached: vi.fn(async () => [{ time: '2026-01-01T00:00:00Z' }]),
}));
vi.mock('../services/backup', () => ({}));
vi.mock('../services/tenantFromBackup', () => ({ createTenantFromBackup: vi.fn() }));
vi.mock('../services/docker', () => ({ getTenantInfo: vi.fn() }));

afterEach(() => {
  delete process.env.TEST_BUCKET;
  delete process.env.TEST_ENDPOINT;
});

async function summary() {
  const { default: router } = await import('../routes/backups');
  const app = express();
  app.use('/api/apps/:appId/backups', router);
  return request(app).get('/api/apps/shop/backups/summary').expect(200);
}

describe('GET /backups/summary', () => {
  const backup = {
    schedule: '0 3 * * *',
    s3: { bucket_env: 'TEST_BUCKET', endpoint_env: 'TEST_ENDPOINT' },
  };

  it('shows schedule, bucket and endpoint when backups are enabled', async () => {
    process.env.TEST_BUCKET = 'my-bucket';
    process.env.TEST_ENDPOINT = 's3.example.com';
    appDef = { id: 'shop', backup: { enabled: true, ...backup } };
    const res = await summary();
    expect(res.body).toMatchObject({ schedule: '0 3 * * *', bucket: 'my-bucket', endpoint: 's3.example.com', totalSnapshots: 1 });
  });

  it('reports null schedule, bucket and endpoint when backups are disabled', async () => {
    process.env.TEST_BUCKET = 'my-bucket';
    process.env.TEST_ENDPOINT = 's3.example.com';
    appDef = { id: 'shop', backup: { enabled: false, ...backup } };
    const res = await summary();
    expect(res.body.schedule).toBeNull();
    expect(res.body.bucket).toBeNull();
    expect(res.body.endpoint).toBeNull();
  });
});
