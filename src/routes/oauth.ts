import express, { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { randomBytes, randomUUID } from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { asyncHandler } from '../utils/asyncHandler';
import { authorizationServerMetadata, protectedResourceMetadata } from '../oauth/metadata';
import {
  registerClient, getClient, touchClient, ClientLimitError, putAuthCode, consumeAuthCode,
  putConsentNonce, consumeConsentNonce, startOAuthSweeper,
  saveRefreshToken, consumeRefreshToken, revokeRefreshToken,
} from '../oauth/store';
import { isAdminEmail, getUserRole, normaliseRole } from '../services/users';
import { issueAccessToken, generateRefreshToken, mcpResourceUrl } from '../oauth/tokens';
import { verifyPkceS256 } from '../oauth/pkce';

export interface OAuthRouterOptions {
  issuer: string;
  accessTokenTtl?: string;   // default '1h'
  refreshTokenTtl?: string;  // default '30d'
}

const REQUEST_TOKEN_AUD = 'mcp-oauth-request';
// Distinct audience so the login request token can't be replayed as a consent token.
const CONSENT_TOKEN_AUD = 'mcp-oauth-consent';
const CONSENT_TTL_MS = 5 * 60_000;
const GRANTED_SCOPE = 'tenants';
const MAX_CLIENT_NAME_LENGTH = 100;
const MAX_REDIRECT_URIS = 10;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

interface AuthorizeParams {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state?: string;
  resource?: string;
  scope?: string;
}

interface ConsentClaims extends AuthorizeParams {
  email: string;
  nonce: string;
}

// Minimal duration parser for refresh-token expiry bookkeeping (s/m/h/d).
function parseDurationMs(ttl: string): number {
  const m = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!m) return 30 * 24 * 3600 * 1000;
  const n = Number(m[1]);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
  return n * unit;
}

// https, or http on a loopback host (native clients); no userinfo, no fragment.
export function isAllowedRedirectUri(u: unknown): u is string {
  if (typeof u !== 'string') return false;
  let parsed: URL;
  try { parsed = new URL(u); } catch { return false; }
  if (parsed.username || parsed.password || parsed.hash || !parsed.hostname) return false;
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
}

function isInsecureRemote(redirectUri: string): boolean {
  try {
    const p = new URL(redirectUri);
    return p.protocol !== 'https:' && !LOOPBACK_HOSTS.has(p.hostname);
  } catch { return true; }
}

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function loginPage(requestToken: string, googleClientId: string): string {
  // Minimal Google Identity Services page; posts the credential + request_token
  // back to the callback. NOTE: the GSI script (accounts.google.com/gsi/client)
  // is intentionally loaded without SRI — Google ships it versionless and does
  // not publish a stable hash; the existing React LoginPage loads it the same way.
  return `<!doctype html><html><head><meta charset="utf-8"><title>Overwatch — Authorize MCP</title>
<script src="https://accounts.google.com/gsi/client" async defer></script></head>
<body>
<h1>Authorize MCP access</h1>
<form id="f" method="POST" action="/oauth/authorize/callback">
  <input type="hidden" name="request_token" value="${htmlEscape(requestToken)}">
  <input type="hidden" name="credential" id="credential">
</form>
<div id="g_id_onload" data-client_id="${htmlEscape(googleClientId)}" data-callback="onCred"></div>
<div class="g_id_signin" data-type="standard"></div>
<script src="/oauth/gsi-callback.js"></script>
</body></html>`;
}

function consentPage(opts: { consentToken: string; clientName?: string; redirectUri: string; scope?: string; email: string }): string {
  const host = new URL(opts.redirectUri).host;
  const warn = isInsecureRemote(opts.redirectUri)
    ? '<p><strong>Warning:</strong> this client redirects over unencrypted HTTP.</p>' : '';
  const requested = opts.scope && opts.scope !== GRANTED_SCOPE
    ? `<p>The client requested scope: <code>${htmlEscape(opts.scope)}</code>. Only <code>${GRANTED_SCOPE}</code> can be granted.</p>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Overwatch — Approve MCP access</title></head>
<body>
<h1>Approve MCP access?</h1>
<p>Signed in as <strong>${htmlEscape(opts.email)}</strong>.</p>
<p>The application <strong>${htmlEscape(opts.clientName || '(unnamed client)')}</strong> wants to act on your behalf.</p>
<ul>
  <li>It will be sent back to: <code>${htmlEscape(host)}</code></li>
  <li>Scope: <code>${GRANTED_SCOPE}</code> (list, start, stop, restart and update tenants, within your role)</li>
</ul>
${requested}${warn}
<p>Only approve if you started this connection from an MCP client you trust.</p>
<form method="POST" action="/oauth/authorize/decision">
  <input type="hidden" name="consent_token" value="${htmlEscape(opts.consentToken)}">
  <button type="submit" name="decision" value="approve">Approve</button>
  <button type="submit" name="decision" value="deny">Deny</button>
</form>
</body></html>`;
}

export function createOAuthRouter(opts: OAuthRouterOptions): Router {
  const router = Router();
  const { issuer } = opts;
  const accessTtl = opts.accessTokenTtl ?? '1h';
  const refreshTtl = opts.refreshTokenTtl ?? '30d';
  const refreshTtlMs = parseDurationMs(refreshTtl);
  const resourceUrl = mcpResourceUrl(issuer);
  startOAuthSweeper();

  router.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
    res.json(authorizationServerMetadata(issuer));
  });

  router.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
    res.json(protectedResourceMetadata(issuer));
  });

  // CSP-safe external GSI callback script (site-wide CSP forbids inline scripts).
  router.get('/oauth/gsi-callback.js', (_req: Request, res: Response) => {
    res.type('application/javascript').send(
      "function onCred(r){document.getElementById('credential').value=r.credential;document.getElementById('f').submit();}"
    );
  });

  // RFC 7591 Dynamic Client Registration (public clients only).
  router.post('/oauth/register', asyncHandler(async (req: Request, res: Response) => {
    const { client_name, redirect_uris } = req.body || {};
    if (!Array.isArray(redirect_uris) || redirect_uris.length === 0 || redirect_uris.length > MAX_REDIRECT_URIS) {
      return res.status(400).json({ error: 'invalid_client_metadata', error_description: `redirect_uris must contain 1-${MAX_REDIRECT_URIS} entries` });
    }
    if (client_name !== undefined && (typeof client_name !== 'string' || client_name.length > MAX_CLIENT_NAME_LENGTH)) {
      return res.status(400).json({ error: 'invalid_client_metadata', error_description: `client_name must be a string of at most ${MAX_CLIENT_NAME_LENGTH} characters` });
    }
    if (!redirect_uris.every(isAllowedRedirectUri)) {
      return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https URLs or http loopback URLs (127.0.0.1, localhost, [::1]) without credentials or fragments' });
    }
    let client;
    try {
      client = await registerClient({ client_name, redirect_uris });
    } catch (err) {
      if (err instanceof ClientLimitError) {
        return res.status(429).json({ error: 'temporarily_unavailable', error_description: 'client registration limit reached' });
      }
      throw err;
    }
    res.status(201).json({
      client_id: client.client_id,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  }));

  const googleClientId = process.env.GOOGLE_CLIENT_ID || '';
  const googleClient = new OAuth2Client(googleClientId);

  // Google credential verification, kept separate from the OAuth flow so it can move
  // into the shared sign-in code. Returns the verified, lowercased email or an error.
  async function verifyGoogleCredential(credential: string): Promise<{ email: string } | { status: number; error: string; description: string }> {
    let payload: import('google-auth-library').TokenPayload | undefined;
    try {
      const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: googleClientId });
      payload = ticket.getPayload();
    } catch {
      return { status: 401, error: 'access_denied', description: 'invalid credential' };
    }
    if (!payload?.email || !payload.email_verified) return { status: 401, error: 'access_denied', description: 'email not verified' };
    return { email: payload.email.toLowerCase() };
  }

  // GET /oauth/authorize — validate params, render login page with a signed request token.
  router.get('/oauth/authorize', asyncHandler(async (req: Request, res: Response) => {
    if (!googleClientId) return res.status(500).json({ error: 'server_misconfiguration', error_description: 'Google OAuth not configured' });
    const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state, resource, scope } = req.query as Record<string, string>;
    if (response_type !== 'code') return res.status(400).json({ error: 'unsupported_response_type' });
    if (code_challenge_method !== 'S256' || !code_challenge) return res.status(400).json({ error: 'invalid_request', error_description: 'PKCE S256 required' });
    const client = await getClient(client_id);
    if (!client) return res.status(400).json({ error: 'invalid_client' });
    if (!client.redirect_uris.includes(redirect_uri)) return res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri not registered' });
    if (resource !== undefined && resource !== resourceUrl) return res.status(400).json({ error: 'invalid_target', error_description: 'unknown resource' });
    if (isInsecureRemote(redirect_uri)) console.warn(`[oauth] client ${client_id} uses a non-loopback http redirect_uri (registered before https was required)`);

    const params: AuthorizeParams = { client_id, redirect_uri, code_challenge, state, resource, scope: typeof scope === 'string' ? scope.slice(0, 200) : undefined };
    const requestToken = jwt.sign(params, process.env.JWT_SECRET!, { algorithm: 'HS256', expiresIn: '10m', audience: REQUEST_TOKEN_AUD, issuer: issuer });
    res.type('html').send(loginPage(requestToken, googleClientId));
  }));

  // POST /oauth/authorize/callback — verify Google credential, check admin, then ask for
  // consent. No code is issued here.
  router.post('/oauth/authorize/callback', express.urlencoded({ extended: false }), asyncHandler(async (req: Request, res: Response) => {
    if (!googleClientId) return res.status(500).json({ error: 'server_misconfiguration', error_description: 'Google OAuth not configured' });
    const { request_token, credential } = req.body || {};
    if (!request_token || !credential) return res.status(400).json({ error: 'invalid_request' });

    let params: AuthorizeParams;
    try {
      params = jwt.verify(request_token, process.env.JWT_SECRET!, { algorithms: ['HS256'], audience: REQUEST_TOKEN_AUD, issuer: issuer }) as AuthorizeParams;
    } catch {
      return res.status(400).json({ error: 'invalid_request', error_description: 'expired or invalid request' });
    }

    const verified = await verifyGoogleCredential(credential);
    if ('error' in verified) return res.status(verified.status).json({ error: verified.error, error_description: verified.description });
    const { email } = verified;
    if (!(await isAdminEmail(email))) {
      return res.status(403).send('<h1>Access denied</h1><p>This Google account is not an Overwatch admin.</p>');
    }
    const client = await getClient(params.client_id);
    if (!client) return res.status(400).json({ error: 'invalid_client' });

    // The consent token is only ever returned to the verified admin who just signed in,
    // is single-use and short-lived, so a cross-site POST cannot approve on their behalf.
    const nonce = randomUUID();
    putConsentNonce(nonce, Date.now() + CONSENT_TTL_MS);
    // Rebuild from known fields: the verified request-token payload also carries exp/aud/iss.
    const claims: ConsentClaims = {
      client_id: params.client_id, redirect_uri: params.redirect_uri, code_challenge: params.code_challenge,
      state: params.state, resource: params.resource, scope: params.scope, email, nonce,
    };
    const consentToken = jwt.sign(claims, process.env.JWT_SECRET!, { algorithm: 'HS256', expiresIn: Math.floor(CONSENT_TTL_MS / 1000), audience: CONSENT_TOKEN_AUD, issuer: issuer });
    res.set('X-Frame-Options', 'DENY'); // clickjacking: the Approve button must not be framable
    res.set('Cache-Control', 'no-store');
    res.type('html').send(consentPage({ consentToken, clientName: client.client_name, redirectUri: params.redirect_uri, scope: params.scope, email }));
  }));

  // POST /oauth/authorize/decision — the user's Approve/Deny. The only place a code is minted.
  router.post('/oauth/authorize/decision', express.urlencoded({ extended: false }), asyncHandler(async (req: Request, res: Response) => {
    const { consent_token, decision } = req.body || {};
    if (!consent_token || (decision !== 'approve' && decision !== 'deny')) return res.status(400).json({ error: 'invalid_request' });

    let claims: ConsentClaims;
    try {
      claims = jwt.verify(consent_token, process.env.JWT_SECRET!, { algorithms: ['HS256'], audience: CONSENT_TOKEN_AUD, issuer: issuer }) as ConsentClaims;
    } catch {
      return res.status(400).json({ error: 'invalid_request', error_description: 'expired or invalid consent request' });
    }
    if (!consumeConsentNonce(claims.nonce)) return res.status(400).json({ error: 'invalid_request', error_description: 'consent already used or expired' });

    const location = new URL(claims.redirect_uri);
    if (decision === 'deny') {
      location.searchParams.set('error', 'access_denied');
      if (claims.state) location.searchParams.set('state', claims.state);
      return res.redirect(302, location.toString());
    }

    // Membership and role may have changed since sign-in; fail closed.
    if (!(await isAdminEmail(claims.email))) return res.status(403).send('<h1>Access denied</h1><p>This Google account is not an Overwatch admin.</p>');
    const role = normaliseRole(await getUserRole(claims.email));
    // The client may have been pruned or removed in the meantime.
    if (!(await getClient(claims.client_id))) return res.status(400).json({ error: 'invalid_client' });
    await touchClient(claims.client_id);

    const code = randomBytes(32).toString('base64url');
    putAuthCode({
      code, client_id: claims.client_id, redirect_uri: claims.redirect_uri,
      code_challenge: claims.code_challenge, email: claims.email, role, resource: claims.resource,
      expires_at: Date.now() + 60_000,
    });
    location.searchParams.set('code', code);
    if (claims.state) location.searchParams.set('state', claims.state);
    res.redirect(302, location.toString());
  }));

  // expires_in is read back from the token so it always matches the configured TTL.
  function tokenResponse(access_token: string, refresh_token: string) {
    const decoded = jwt.decode(access_token) as jwt.JwtPayload | null;
    const expires_in = decoded?.exp && decoded.iat ? decoded.exp - decoded.iat : 3600;
    return { token_type: 'Bearer', access_token, refresh_token, expires_in, scope: GRANTED_SCOPE };
  }

  router.post('/oauth/token', express.urlencoded({ extended: false }), asyncHandler(async (req: Request, res: Response) => {
    const grant = req.body?.grant_type;
    const clientId = typeof req.body?.client_id === 'string' ? req.body.client_id : '';
    const resource = req.body?.resource;
    if (resource !== undefined && resource !== resourceUrl) {
      return res.status(400).json({ error: 'invalid_target', error_description: 'unknown resource' });
    }

    if (grant === 'authorization_code') {
      const { code, redirect_uri, code_verifier } = req.body;
      const rec = consumeAuthCode(code);
      if (!rec) return res.status(400).json({ error: 'invalid_grant', error_description: 'unknown or expired code' });
      if (!clientId || rec.client_id !== clientId) return res.status(400).json({ error: 'invalid_grant', error_description: 'client_id mismatch' });
      if (rec.redirect_uri !== redirect_uri) return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      if (!verifyPkceS256(code_verifier, rec.code_challenge)) return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      // Re-check admin membership at token time (revocation safety).
      if (!(await isAdminEmail(rec.email))) return res.status(400).json({ error: 'invalid_grant', error_description: 'account no longer authorized' });

      const access_token = issueAccessToken({ email: rec.email, role: rec.role, issuer, ttl: accessTtl });
      const refresh_token = generateRefreshToken();
      await saveRefreshToken(refresh_token, { client_id: rec.client_id, email: rec.email, expires_at: Date.now() + refreshTtlMs });
      await touchClient(rec.client_id);
      return res.json(tokenResponse(access_token, refresh_token));
    }

    if (grant === 'refresh_token') {
      const rec = await consumeRefreshToken(req.body?.refresh_token);
      if (!rec) return res.status(400).json({ error: 'invalid_grant', error_description: 'unknown or expired refresh token' });
      // The token is already consumed, so a mismatching client burns it (likely stolen).
      if (!clientId || rec.client_id !== clientId) return res.status(400).json({ error: 'invalid_grant', error_description: 'client_id mismatch' });
      if (!(await isAdminEmail(rec.email))) return res.status(400).json({ error: 'invalid_grant', error_description: 'account no longer authorized' });
      const role = normaliseRole(await getUserRole(rec.email));
      const access_token = issueAccessToken({ email: rec.email, role, issuer, ttl: accessTtl });
      const refresh_token = generateRefreshToken(); // rotation
      await saveRefreshToken(refresh_token, { client_id: rec.client_id, email: rec.email, expires_at: Date.now() + refreshTtlMs });
      await touchClient(rec.client_id);
      return res.json(tokenResponse(access_token, refresh_token));
    }

    return res.status(400).json({ error: 'unsupported_grant_type' });
  }));

  router.post('/oauth/revoke', express.urlencoded({ extended: false }), asyncHandler(async (req: Request, res: Response) => {
    if (req.body?.token) await revokeRefreshToken(req.body.token);
    res.status(200).json({}); // RFC 7009: always 200
  }));

  return router;
}
