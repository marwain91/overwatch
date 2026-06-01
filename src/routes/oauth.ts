import { Router, Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { authorizationServerMetadata, protectedResourceMetadata } from '../oauth/metadata';
import { registerClient } from '../oauth/store';

export interface OAuthRouterOptions {
  issuer: string;
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
    if (!redirect_uris.every((u: unknown) => typeof u === 'string' && /^https?:\/\//.test(u))) {
      return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be absolute http(s) URLs' });
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

  return router;
}
