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

  it('rejects an oversized redirect_uri', async () => {
    const res = await request(appWith())
      .post('/oauth/register')
      .send({ client_name: 'x', redirect_uris: [`https://client/cb?${'a'.repeat(4096)}`] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_redirect_uri');
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

  const reg = (body: object) => request(appWith()).post('/oauth/register').send(body);

  it.each([
    'https://client.example/cb',
    'http://127.0.0.1:8123/cb',
    'http://localhost/cb',
    'http://localhost:3000/cb',
    'http://[::1]:9000/cb',
    'HTTPS://client.example/cb',
    'HTTP://127.0.0.1/cb',
    'http://[0:0:0:0:0:0:0:1]/cb', // normalised to [::1]
  ])('accepts redirect uri %s', async (u) => {
    expect((await reg({ client_name: 'x', redirect_uris: [u] })).status).toBe(201);
  });

  it.each([
    'http://client.example/cb',
    'HTTP://client.example/cb',
    'http://127.0.0.1.evil.com/cb',
    'http://localhost.evil.com/cb',
    'ftp://client.example/cb',
    'javascript:alert(1)',
    'myapp://cb',
    'https://user:pw@client.example/cb',
    'https://client.example/cb#frag',
  ])('rejects redirect uri %s', async (u) => {
    const res = await reg({ client_name: 'x', redirect_uris: [u] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_redirect_uri');
  });

  it('rejects a non-string or oversized client_name', async () => {
    expect((await reg({ client_name: { a: 1 }, redirect_uris: ['https://c/cb'] })).status).toBe(400);
    expect((await reg({ client_name: 'n'.repeat(101), redirect_uris: ['https://c/cb'] })).status).toBe(400);
  });

  it('rejects too many redirect uris', async () => {
    const uris = Array.from({ length: 11 }, (_, i) => `https://c/cb${i}`);
    expect((await reg({ client_name: 'x', redirect_uris: uris })).status).toBe(400);
  });

  it('refuses registration once the client cap is reached by used clients', async () => {
    const clients = Array.from({ length: 200 }, (_, i) => ({
      client_id: `c${i}`, redirect_uris: ['https://c/cb'], created_at: new Date().toISOString(), last_used_at: new Date().toISOString(),
    }));
    await fs.writeFile(path.join(tmpDir, 'mcp-oauth.json'), JSON.stringify({ clients, refreshTokens: [] }));
    const res = await reg({ client_name: 'x', redirect_uris: ['https://c/cb'] });
    expect(res.status).toBe(429);
  });
});
