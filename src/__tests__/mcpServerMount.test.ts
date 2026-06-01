import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

let tmpDir: string;
vi.mock('../config', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, getDataDir: () => tmpDir };
});

import { mountMcp } from '../mcp/server';

const ISSUER = 'https://ow.example.com';

describe('mountMcp', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-mcpmount-'));
    process.env.JWT_SECRET = 'x'.repeat(40);
    process.env.GOOGLE_CLIENT_ID = 'cid';
  });

  it('serves protected-resource metadata without auth', async () => {
    const app = express();
    app.use(express.json());
    mountMcp(app, { issuer: ISSUER, accessTokenTtl: '1h', refreshTokenTtl: '30d' });
    const res = await request(app).get('/.well-known/oauth-protected-resource');
    expect(res.status).toBe(200);
    expect(res.body.resource).toBe('https://ow.example.com/mcp');
  });

  it('rejects an unauthenticated /mcp request with 401 + WWW-Authenticate', async () => {
    const app = express();
    app.use(express.json());
    mountMcp(app, { issuer: ISSUER, accessTokenTtl: '1h', refreshTokenTtl: '30d' });
    const res = await request(app).post('/mcp').send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/Bearer/);
  });
});
