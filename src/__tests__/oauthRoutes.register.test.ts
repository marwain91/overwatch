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

import { createOAuthRouter } from '../routes/oauth';

const ISSUER = 'https://ow.example.com';

function appWith() {
  const app = express();
  app.use(express.json());
  app.use(createOAuthRouter({ issuer: ISSUER }));
  return app;
}

describe('oauth /register + metadata', () => {
  beforeEach(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-oauthr-')); });

  it('serves AS metadata', async () => {
    const res = await request(appWith()).get('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(res.body.issuer).toBe(ISSUER);
  });

  it('registers a public client', async () => {
    const res = await request(appWith())
      .post('/oauth/register')
      .send({ client_name: 'claude', redirect_uris: ['https://client/cb'] });
    expect(res.status).toBe(201);
    expect(res.body.client_id).toMatch(/.+/);
    expect(res.body.token_endpoint_auth_method).toBe('none');
  });

  it('rejects registration without redirect_uris', async () => {
    const res = await request(appWith()).post('/oauth/register').send({ client_name: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client_metadata');
  });

  it('rejects a redirect_uri with no host', async () => {
    const res = await request(appWith())
      .post('/oauth/register')
      .send({ client_name: 'x', redirect_uris: ['http://'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_redirect_uri');
  });
});
