import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../adapters/database');
  vi.doUnmock('../services/app');
  vi.doUnmock('../services/tenantStore');
});

describe('GET /api/database/databases tenant classification', () => {
  it('reads tenant .env files in parallel, capped, and still classifies every tenant DB', async () => {
    const tenants = Array.from({ length: 30 }, (_, i) => ({ appId: i % 2 ? 'a' : 'b', tenantId: `t${i}` }));
    let inFlight = 0;
    let peak = 0;
    vi.doMock('../services/app', () => ({ listApps: async () => [{ id: 'a' }, { id: 'b' }] }));
    vi.doMock('../services/tenantStore', () => ({
      listTenantDirs: async (appId: string) => tenants.filter(t => t.appId === appId),
      readTenantEnv: async (appId: string, tenantId: string) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise(r => setTimeout(r, 5));
        inFlight--;
        if (tenantId === 't3') throw Object.assign(new Error('no .env'), { code: 'ENOENT' });
        return tenantId === 't4' ? {} : { DB_NAME: `${appId}_${tenantId}` };
      },
    }));
    vi.doMock('../adapters/database', () => ({
      getDatabaseAdapter: () => ({
        getDatabasesWithDetails: async () => [
          ...tenants.map(t => ({ name: `${t.appId}_${t.tenantId}`, sizeBytes: 0, tableCount: 0, isTenantDb: false })),
          { name: 'mysql', sizeBytes: 0, tableCount: 0, isTenantDb: true },
        ],
      }),
    }));
    const { default: router } = await import('../routes/database');
    const app = express();
    app.use('/api/database', router);

    const res = await request(app).get('/api/database/databases').expect(200);
    const tenantDbs = res.body.filter((d: any) => d.isTenantDb).map((d: any) => d.name).sort();
    const expected = tenants.filter(t => !['t3', 't4'].includes(t.tenantId)).map(t => `${t.appId}_${t.tenantId}`).sort();
    expect(tenantDbs).toEqual(expected);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(10);
  });
});
