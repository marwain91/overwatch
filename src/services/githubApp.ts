import jwt from 'jsonwebtoken';

export interface GitHubAppCredentials {
  appId: string;
  privateKey: string;
  installationId: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();
const inflight = new Map<string, Promise<string>>();

const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const JWT_TTL_SECONDS = 9 * 60;
const JWT_BACKDATE_SECONDS = 60;

function decodePrivateKey(raw: string): string {
  if (raw.startsWith('-----BEGIN')) return raw;
  return Buffer.from(raw, 'base64').toString('utf8');
}

function cacheKey(creds: GitHubAppCredentials): string {
  return `${creds.appId}::${creds.installationId}`;
}

async function mintInstallationToken(creds: GitHubAppCredentials): Promise<{ token: string; expiresAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const appJwt = jwt.sign(
    { iat: now - JWT_BACKDATE_SECONDS, exp: now + JWT_TTL_SECONDS, iss: creds.appId },
    decodePrivateKey(creds.privateKey),
    { algorithm: 'RS256' },
  );

  const url = `https://api.github.com/app/installations/${creds.installationId}/access_tokens`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${appJwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `GitHub App installation token request failed (HTTP ${response.status}). ` +
        `Verify the App ID, installation ID, and private key are correct, and that the ` +
        `App is installed on the repository. ${body ? `GitHub said: ${body}` : ''}`.trim(),
    );
  }

  const body = (await response.json()) as { token: string; expires_at: string };
  return { token: body.token, expiresAt: new Date(body.expires_at).getTime() };
}

export async function getInstallationToken(creds: GitHubAppCredentials): Promise<string> {
  const key = cacheKey(creds);
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return hit.token;
  }
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    const minted = await mintInstallationToken(creds);
    tokenCache.set(key, minted);
    return minted.token;
  })().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, promise);
  return promise;
}

export function clearGitHubAppTokenCache(): void {
  tokenCache.clear();
  inflight.clear();
}
