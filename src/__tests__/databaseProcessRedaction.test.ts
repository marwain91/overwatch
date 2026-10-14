import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const PROCESSES = [
  { id: 7, user: 'root', database: null, host: 'localhost', command: 'Query', time: 3, state: 'executing',
    query: "CREATE USER 'acme_t1'@'%' IDENTIFIED BY 'S3cretPw'" },
  { id: 8, user: 'app', database: 'acme_t1', host: '10.0.0.4', command: 'Sleep', time: 90, state: '', query: null },
];

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../adapters/database');
});

async function listAs(role: 'viewer' | 'editor' | 'admin' | undefined) {
  vi.doMock('../adapters/database', () => ({
    getDatabaseAdapter: () => ({ getProcessList: async () => PROCESSES.map(p => ({ ...p })) }),
  }));
  const { default: router } = await import('../routes/database');
  const app = express();
  // Stands in for authMiddleware.
  app.use((_req, res, next) => { if (role) res.locals.user = { email: 'u@example.test', role }; next(); });
  app.use('/api/database', router);
  return request(app).get('/api/database/processes').expect(200);
}

describe('GET /api/database/processes statement text', () => {
  it.each(['viewer', 'editor'] as const)('is hidden from %s callers', async (role) => {
    const res = await listAs(role);
    expect(JSON.stringify(res.body)).not.toMatch(/S3cretPw|IDENTIFIED/);
    expect(res.body[0].query).toBe('[hidden]');
    // Rows without a statement stay null; the rest of the row is untouched.
    expect(res.body[1].query).toBeNull();
    expect(res.body[0]).toMatchObject({ id: 7, user: 'root', command: 'Query', time: 3 });
  });

  it('is hidden when the caller has no resolved role (no fail-open)', async () => {
    const res = await listAs(undefined);
    expect(JSON.stringify(res.body)).not.toContain('S3cretPw');
  });

  it('is shown to admins', async () => {
    const res = await listAs('admin');
    expect(res.body[0].query).toBe(PROCESSES[0].query);
  });
});
