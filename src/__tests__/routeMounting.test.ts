import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// src/index.ts calls start() on import, so the wiring is asserted on source.
const INDEX_PATH = path.join(__dirname, '..', 'index.ts');

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../config');
  vi.doUnmock('../utils/jwt');
});

describe('src/index.ts route mounting', () => {
  it('mounts app-scoped routers before the /api/apps prefix so middleware runs once', async () => {
    const src = await fs.readFile(INDEX_PATH, 'utf-8');
    const appsMount = src.indexOf("app.use('/api/apps', ");
    expect(appsMount).toBeGreaterThan(-1);
    for (const sub of ['tenants', 'env-vars', 'backups']) {
      const nested = src.indexOf(`app.use('/api/apps/:appId/${sub}'`);
      expect(nested).toBeGreaterThan(-1);
      expect(nested).toBeLessThan(appsMount);
    }
  });

  it('audits /api/status mutations (container restart)', async () => {
    const src = await fs.readFile(INDEX_PATH, 'utf-8');
    expect(src).toMatch(/app\.use\('\/api\/status',[^\n]*\bauditLog\b/);
  });

  it('loads .env before any module that reads process.env at import time', async () => {
    const src = await fs.readFile(INDEX_PATH, 'utf-8');
    const firstImport = src.split('\n').find(l => l.startsWith('import '));
    expect(firstImport).toBe("import 'dotenv/config';");
    expect(src).not.toMatch(/dotenv\.config\(/);
  });

  it('writes exactly one audit line per nested mutation with that mount order', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-route-mounting-'));
    try {
      vi.doMock('../config', () => ({ getDataDir: () => dataDir }));
      vi.doMock('../utils/jwt', () => ({ getCurrentUserEmail: () => 'admin@example.test' }));
      const { auditLog, flushAuditLog } = await import('../middleware/audit');

      const tenants = express.Router({ mergeParams: true });
      tenants.post('/:tenantId/restart', (_req, res) => { res.json({ ok: true }); });
      const app = express();
      app.use(express.json());
      app.use('/api/apps/:appId/tenants', auditLog, tenants);
      app.use('/api/apps', auditLog, express.Router());

      await request(app).post('/api/apps/demo/tenants/t1/restart').expect(200);
      await flushAuditLog();

      const lines = (await fs.readFile(path.join(dataDir, 'audit.log'), 'utf-8')).trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).action).toBe('restart tenant t1');
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
