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

// Mock Google verification + admin lookup.
const verifyIdToken = vi.fn();
vi.mock('google-auth-library', () => ({
  OAuth2Client: class { verifyIdToken = verifyIdToken; },
}));
vi.mock('../services/users', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, isAdminEmail: vi.fn(async () => true), getUserRole: vi.fn(async () => 'editor') };
});

import { createOAuthRouter } from '../routes/oauth';
import { registerClient } from '../oauth/store';

const ISSUER = 'https://ow.example.com';
function appWith() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(createOAuthRouter({ issuer: ISSUER }));
  return app;
}

describe('oauth /authorize', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-oautha-'));
    process.env.JWT_SECRET = 'x'.repeat(40);
    process.env.GOOGLE_CLIENT_ID = 'cid';
    verifyIdToken.mockReset();
  });

  it('renders a login page for a valid authorize request', async () => {
    const client = await registerClient({ client_name: 'c', redirect_uris: ['https://client/cb'] });
    const res = await request(appWith()).get('/oauth/authorize').query({
      response_type: 'code', client_id: client.client_id, redirect_uri: 'https://client/cb',
      code_challenge: 'abc', code_challenge_method: 'S256', state: 's1',
    });
    expect(res.status).toBe(200);
    expect(res.text).toContain('accounts.google.com/gsi/client'); // GIS script
  });

  it('rejects a redirect_uri that is not registered', async () => {
    const client = await registerClient({ client_name: 'c', redirect_uris: ['https://client/cb'] });
    const res = await request(appWith()).get('/oauth/authorize').query({
      response_type: 'code', client_id: client.client_id, redirect_uri: 'https://evil/cb',
      code_challenge: 'abc', code_challenge_method: 'S256', state: 's1',
    });
    expect(res.status).toBe(400);
  });

  it('callback issues a code and redirects for an admin', async () => {
    const client = await registerClient({ client_name: 'c', redirect_uris: ['https://client/cb'] });
    const page = await request(appWith()).get('/oauth/authorize').query({
      response_type: 'code', client_id: client.client_id, redirect_uri: 'https://client/cb',
      code_challenge: 'abc', code_challenge_method: 'S256', state: 's1',
    });
    const reqToken = /name="request_token" value="([^"]+)"/.exec(page.text)![1];
    verifyIdToken.mockResolvedValue({ getPayload: () => ({ email: 'a@b.c', email_verified: true, name: 'A' }) });

    const res = await request(appWith())
      .post('/oauth/authorize/callback')
      .type('form')
      .send({ request_token: reqToken, credential: 'google-jwt' });

    expect(res.status).toBe(302);
    const loc = new URL(res.headers.location);
    expect(loc.origin + loc.pathname).toBe('https://client/cb');
    expect(loc.searchParams.get('code')).toMatch(/.+/);
    expect(loc.searchParams.get('state')).toBe('s1');
  });

  it('callback denies a non-admin', async () => {
    const users = await import('../services/users');
    (users.isAdminEmail as any).mockResolvedValueOnce(false);
    const client = await registerClient({ client_name: 'c', redirect_uris: ['https://client/cb'] });
    const page = await request(appWith()).get('/oauth/authorize').query({
      response_type: 'code', client_id: client.client_id, redirect_uri: 'https://client/cb',
      code_challenge: 'abc', code_challenge_method: 'S256', state: 's1',
    });
    const reqToken = /name="request_token" value="([^"]+)"/.exec(page.text)![1];
    verifyIdToken.mockResolvedValue({ getPayload: () => ({ email: 'x@y.z', email_verified: true }) });
    const res = await request(appWith())
      .post('/oauth/authorize/callback').type('form')
      .send({ request_token: reqToken, credential: 'google-jwt' });
    expect(res.status).toBe(403);
  });

  it('callback rejects an invalid Google credential with 401', async () => {
    const client = await registerClient({ client_name: 'c', redirect_uris: ['https://client/cb'] });
    const page = await request(appWith()).get('/oauth/authorize').query({
      response_type: 'code', client_id: client.client_id, redirect_uri: 'https://client/cb',
      code_challenge: 'abc', code_challenge_method: 'S256', state: 's1',
    });
    const reqToken = /name="request_token" value="([^"]+)"/.exec(page.text)![1];
    verifyIdToken.mockRejectedValueOnce(new Error('Token used too late'));
    const res = await request(appWith()).post('/oauth/authorize/callback').type('form')
      .send({ request_token: reqToken, credential: 'bad' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('access_denied');
    expect(JSON.stringify(res.body)).not.toContain('Token used too late'); // no detail leak
  });

  it('serves the external GSI callback script (CSP-safe)', async () => {
    const res = await request(appWith()).get('/oauth/gsi-callback.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.text).toContain('onCred');
  });
});
