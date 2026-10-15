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

const verifyIdToken = vi.fn();
vi.mock('google-auth-library', () => ({
  OAuth2Client: class { verifyIdToken = verifyIdToken; },
}));
vi.mock('../services/users', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, isAdminEmail: vi.fn(async () => true), getUserRole: vi.fn(async () => 'editor') };
});

const writeAuditEntry = vi.fn();
vi.mock('../services/auditLog', () => ({ writeAuditEntry: (e: unknown) => writeAuditEntry(e) }));

import { createOAuthRouter } from '../routes/oauth';
import { registerClient, getClient, consumeAuthCode } from '../oauth/store';
import { isAdminEmail } from '../services/users';

const ISSUER = 'https://ow.example.com';
function appWith() {
  const app = express();
  app.use(createOAuthRouter({ issuer: ISSUER }));
  return app;
}

async function reachConsent(clientName: string | undefined, redirect = 'https://client.example/cb', extra: Record<string, string> = {}) {
  const client = await registerClient({ client_name: clientName, redirect_uris: [redirect] });
  const page = await request(appWith()).get('/oauth/authorize').query({
    response_type: 'code', client_id: client.client_id, redirect_uri: redirect,
    code_challenge: 'abc', code_challenge_method: 'S256', state: 's1', ...extra,
  });
  const reqToken = /name="request_token" value="([^"]+)"/.exec(page.text)![1];
  verifyIdToken.mockResolvedValue({ getPayload: () => ({ email: 'a@b.c', email_verified: true }) });
  const consent = await request(appWith()).post('/oauth/authorize/callback').type('form')
    .send({ request_token: reqToken, credential: 'google-jwt' });
  const m = /name="consent_token" value="([^"]+)"/.exec(consent.text);
  return { client, consent, consentToken: m?.[1] as string };
}

describe('oauth consent step', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-oauthc-'));
    process.env.JWT_SECRET = 'x'.repeat(40);
    process.env.GOOGLE_CLIENT_ID = 'cid';
    verifyIdToken.mockReset();
    writeAuditEntry.mockReset();
    (isAdminEmail as any).mockResolvedValue(true);
  });

  it('shows the full redirect URI, not only its host', async () => {
    const { consent } = await reachConsent('c', 'https://client.example:8443/oauth/callback/evil-path?hint=1');
    expect(consent.text).toContain('https://client.example:8443/oauth/callback/evil-path?hint=1');
  });

  it('audits an approval and a denial', async () => {
    const approved = await reachConsent('Claude');
    await request(appWith()).post('/oauth/authorize/decision').type('form')
      .send({ consent_token: approved.consentToken, decision: 'approve' });
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
      user: 'a@b.c', action: 'oauth consent approved', path: '/oauth/authorize/decision',
      body: expect.objectContaining({ client_id: approved.client.client_id, client_name: 'Claude', redirect_uri: 'https://client.example/cb' }),
    }));
    const denied = await reachConsent('Other');
    await request(appWith()).post('/oauth/authorize/decision').type('form')
      .send({ consent_token: denied.consentToken, decision: 'deny' });
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
      user: 'a@b.c', action: 'oauth consent denied', body: expect.objectContaining({ client_id: denied.client.client_id }),
    }));
  });

  it('audits a sign-in by a Google account that is not an admin', async () => {
    const client = await registerClient({ client_name: 'c', redirect_uris: ['https://client.example/cb'] });
    const page = await request(appWith()).get('/oauth/authorize').query({
      response_type: 'code', client_id: client.client_id, redirect_uri: 'https://client.example/cb',
      code_challenge: 'abc', code_challenge_method: 'S256',
    });
    const reqToken = /name="request_token" value="([^"]+)"/.exec(page.text)![1];
    verifyIdToken.mockResolvedValue({ getPayload: () => ({ email: 'intruder@b.c', email_verified: true }) });
    (isAdminEmail as any).mockResolvedValue(false);
    const res = await request(appWith()).post('/oauth/authorize/callback').type('form')
      .send({ request_token: reqToken, credential: 'google-jwt' });
    expect(res.status).toBe(403);
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ user: 'intruder@b.c', action: 'oauth login denied', status: 403 }));
  });

  it('names the client, the redirect host, the scope and the signed-in account', async () => {
    const { consent } = await reachConsent('Claude Desktop', 'https://client.example:8443/cb');
    expect(consent.status).toBe(200);
    expect(consent.text).toContain('Claude Desktop');
    expect(consent.text).toContain('client.example:8443');
    expect(consent.text).toContain('tenants');
    expect(consent.text).toContain('a@b.c');
    expect(consent.text).toMatch(/value="approve"/);
    expect(consent.text).toMatch(/value="deny"/);
    expect(consent.headers['x-frame-options']).toBe('DENY');
  });

  it('escapes an attacker-controlled client_name', async () => {
    const { consent } = await reachConsent('<script>alert(1)</script>"><img src=x>');
    expect(consent.text).not.toContain('<script>alert(1)');
    expect(consent.text).not.toContain('<img src=x>');
    expect(consent.text).toContain('&lt;script&gt;');
  });

  it('escapes a requested scope', async () => {
    const { consent } = await reachConsent('c', 'https://client.example/cb', { scope: '"><svg onload=x>' });
    expect(consent.text).not.toContain('<svg onload=x>');
  });

  it('issues no code until approved', async () => {
    const { consent } = await reachConsent('c');
    expect(consent.status).toBe(200);
    expect(consent.text).not.toMatch(/[?&]code=/);
  });

  it('approve issues a code bound to the client and redirects with state', async () => {
    const { client, consentToken } = await reachConsent('c');
    const res = await request(appWith()).post('/oauth/authorize/decision').type('form')
      .send({ consent_token: consentToken, decision: 'approve' });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.location);
    expect(loc.origin + loc.pathname).toBe('https://client.example/cb');
    expect(loc.searchParams.get('state')).toBe('s1');
    const rec = consumeAuthCode(loc.searchParams.get('code')!);
    expect(rec?.client_id).toBe(client.client_id);
    expect(rec?.email).toBe('a@b.c');
    expect(rec?.role).toBe('editor');
    expect((await getClient(client.client_id))?.last_used_at).toBeDefined();
  });

  it('deny redirects with access_denied and no code', async () => {
    const { consentToken } = await reachConsent('c');
    const res = await request(appWith()).post('/oauth/authorize/decision').type('form')
      .send({ consent_token: consentToken, decision: 'deny' });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.location);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('s1');
    expect(loc.searchParams.get('code')).toBeNull();
  });

  it('missing or unknown decision issues nothing', async () => {
    const { consentToken } = await reachConsent('c');
    const res = await request(appWith()).post('/oauth/authorize/decision').type('form')
      .send({ consent_token: consentToken });
    expect(res.status).toBe(400);
    expect(res.headers.location).toBeUndefined();
  });

  it('rejects a forged or wrong-audience consent token (the login request token is not enough)', async () => {
    const client = await registerClient({ client_name: 'c', redirect_uris: ['https://client.example/cb'] });
    const page = await request(appWith()).get('/oauth/authorize').query({
      response_type: 'code', client_id: client.client_id, redirect_uri: 'https://client.example/cb',
      code_challenge: 'abc', code_challenge_method: 'S256',
    });
    const reqToken = /name="request_token" value="([^"]+)"/.exec(page.text)![1];
    for (const bad of [reqToken, 'garbage']) {
      const res = await request(appWith()).post('/oauth/authorize/decision').type('form')
        .send({ consent_token: bad, decision: 'approve' });
      expect(res.status).toBe(400);
      expect(res.headers.location).toBeUndefined();
    }
  });

  it('a consent token is single-use', async () => {
    const { consentToken } = await reachConsent('c');
    const first = await request(appWith()).post('/oauth/authorize/decision').type('form')
      .send({ consent_token: consentToken, decision: 'approve' });
    expect(first.status).toBe(302);
    const replay = await request(appWith()).post('/oauth/authorize/decision').type('form')
      .send({ consent_token: consentToken, decision: 'approve' });
    expect(replay.status).toBe(400);
  });

  it('re-checks admin membership at approval time', async () => {
    const { consentToken } = await reachConsent('c');
    (isAdminEmail as any).mockResolvedValue(false);
    const res = await request(appWith()).post('/oauth/authorize/decision').type('form')
      .send({ consent_token: consentToken, decision: 'approve' });
    expect(res.status).toBe(403);
    expect(res.headers.location).toBeUndefined();
  });
});
