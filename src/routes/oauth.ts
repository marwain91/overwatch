import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { asyncHandler } from '../utils/asyncHandler';
import { authorizationServerMetadata, protectedResourceMetadata } from '../oauth/metadata';
import { registerClient, getClient, putAuthCode } from '../oauth/store';
import { isAdminEmail, getUserRole, normaliseRole } from '../services/users';

export interface OAuthRouterOptions {
  issuer: string;
}

const REQUEST_TOKEN_AUD = 'mcp-oauth-request';

interface AuthorizeParams {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state?: string;
  resource?: string;
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
<script>function onCred(r){document.getElementById('credential').value=r.credential;document.getElementById('f').submit();}</script>
</body></html>`;
}

export function createOAuthRouter(opts: OAuthRouterOptions): Router {
  const router = Router();
  const { issuer } = opts;

  router.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
    res.json(authorizationServerMetadata(issuer));
  });

  router.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
    res.json(protectedResourceMetadata(issuer));
  });

  // RFC 7591 Dynamic Client Registration (public clients only).
  router.post('/oauth/register', asyncHandler(async (req: Request, res: Response) => {
    const { client_name, redirect_uris } = req.body || {};
    if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris is required' });
    }
    const isValidRedirectUri = (u: unknown): u is string => {
      if (typeof u !== 'string') return false;
      try {
        const parsed = new URL(u);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host.length > 0;
      } catch {
        return false;
      }
    };
    if (!redirect_uris.every(isValidRedirectUri)) {
      return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be absolute http(s) URLs with a host' });
    }
    const client = await registerClient({ client_name, redirect_uris });
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

  // GET /oauth/authorize — validate params, render login page with a signed request token.
  router.get('/oauth/authorize', asyncHandler(async (req: Request, res: Response) => {
    const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state, resource } = req.query as Record<string, string>;
    if (response_type !== 'code') return res.status(400).json({ error: 'unsupported_response_type' });
    if (code_challenge_method !== 'S256' || !code_challenge) return res.status(400).json({ error: 'invalid_request', error_description: 'PKCE S256 required' });
    const client = await getClient(client_id);
    if (!client) return res.status(400).json({ error: 'invalid_client' });
    if (!client.redirect_uris.includes(redirect_uri)) return res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri not registered' });

    const params: AuthorizeParams = { client_id, redirect_uri, code_challenge, state, resource };
    const requestToken = jwt.sign(params, process.env.JWT_SECRET!, { algorithm: 'HS256', expiresIn: '10m', audience: REQUEST_TOKEN_AUD });
    res.type('html').send(loginPage(requestToken, googleClientId));
  }));

  // POST /oauth/authorize/callback — verify Google credential, check admin, mint code.
  router.post('/oauth/authorize/callback', asyncHandler(async (req: Request, res: Response) => {
    const { request_token, credential } = req.body || {};
    if (!request_token || !credential) return res.status(400).json({ error: 'invalid_request' });

    let params: AuthorizeParams;
    try {
      params = jwt.verify(request_token, process.env.JWT_SECRET!, { algorithms: ['HS256'], audience: REQUEST_TOKEN_AUD }) as AuthorizeParams;
    } catch {
      return res.status(400).json({ error: 'invalid_request', error_description: 'expired or invalid request' });
    }

    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: googleClientId });
    const payload = ticket.getPayload();
    if (!payload?.email || !payload.email_verified) return res.status(401).json({ error: 'access_denied', error_description: 'email not verified' });
    const email = payload.email.toLowerCase();
    if (!(await isAdminEmail(email))) {
      return res.status(403).send('<h1>Access denied</h1><p>This Google account is not an Overwatch admin.</p>');
    }
    const role = normaliseRole(await getUserRole(email));

    const code = randomBytes(32).toString('base64url');
    putAuthCode({
      code, client_id: params.client_id, redirect_uri: params.redirect_uri,
      code_challenge: params.code_challenge, email, role, resource: params.resource,
      expires_at: Date.now() + 60_000,
    });

    const location = new URL(params.redirect_uri);
    location.searchParams.set('code', code);
    if (params.state) location.searchParams.set('state', params.state);
    res.redirect(302, location.toString());
  }));

  return router;
}
