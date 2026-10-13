import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let dataDir: string;

function entry(user: string, action: string, i: number) {
  return JSON.stringify({
    timestamp: `2026-01-01T00:00:0${i}.000Z`, user, action, method: 'POST', path: '/api/x', status: 200, ip: '127.0.0.1',
  });
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-audit-logs-'));
  await fs.writeFile(path.join(dataDir, 'audit.log'), [
    entry('alice@example.test', 'create tenant a', 1),
    entry('bob@example.test', 'create tenant b', 2),
    entry('alice@example.test', 'delete tenant a', 3),
  ].join('\n') + '\n');
  vi.doMock('../config', () => ({ getDataDir: () => dataDir }));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
  vi.resetModules();
  vi.doUnmock('../config');
});

async function makeApp() {
  const { default: router } = await import('../routes/auditLogs');
  const app = express();
  app.use('/api/audit-logs', router);
  return app;
}

describe('GET /api/audit-logs', () => {
  it('uses the first value of a repeated ?user= instead of filtering everything out', async () => {
    const res = await request(await makeApp()).get('/api/audit-logs?user=alice&user=bob').expect(200);
    expect(res.body.map((e: { user: string }) => e.user)).toEqual(['alice@example.test', 'alice@example.test']);
  });

  it('clamps a negative limit to 1 instead of returning nothing', async () => {
    const res = await request(await makeApp()).get('/api/audit-logs?limit=-5').expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].action).toBe('delete tenant a');
  });
});
