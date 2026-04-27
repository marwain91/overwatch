import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fakePem = '-----BEGIN RSA PRIVATE KEY-----\nFAKE_KEY_BODY\n-----END RSA PRIVATE KEY-----';
const base64Pem = Buffer.from(fakePem, 'utf8').toString('base64');

let signCalls: Array<{ payload: any; key: string; opts: any }> = [];
vi.mock('jsonwebtoken', () => ({
  default: {
    sign: (payload: any, key: any, opts: any) => {
      signCalls.push({ payload, key: typeof key === 'string' ? key : key.toString(), opts });
      return `signed.${payload.iss}.${payload.exp}`;
    },
  },
  sign: (payload: any, key: any, opts: any) => {
    signCalls.push({ payload, key: typeof key === 'string' ? key : key.toString(), opts });
    return `signed.${payload.iss}.${payload.exp}`;
  },
}));

import { getInstallationToken, clearGitHubAppTokenCache } from '../services/githubApp';

const baseCreds = { appId: '123', installationId: '999', privateKey: fakePem };

const fetchMock = vi.fn();

describe('getInstallationToken', () => {
  beforeEach(() => {
    clearGitHubAppTokenCache();
    signCalls = [];
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mintResponse(token: string, secondsFromNow: number) {
    const expiresAt = new Date(Date.now() + secondsFromNow * 1000).toISOString();
    return {
      ok: true,
      status: 201,
      json: async () => ({ token, expires_at: expiresAt }),
      text: async () => '',
    };
  }

  it('mints a token, signs JWT with RS256 / iss=appId / ~10-min exp', async () => {
    fetchMock.mockResolvedValueOnce(mintResponse('inst-token-1', 3600));

    const token = await getInstallationToken(baseCreds);

    expect(token).toBe('inst-token-1');
    expect(signCalls).toHaveLength(1);
    expect(signCalls[0].opts).toMatchObject({ algorithm: 'RS256' });
    expect(signCalls[0].payload.iss).toBe('123');
    const ttl = signCalls[0].payload.exp - signCalls[0].payload.iat;
    expect(ttl).toBeGreaterThan(9 * 60);
    expect(ttl).toBeLessThanOrEqual(11 * 60);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/app/installations/999/access_tokens');
    expect((init as any).method).toBe('POST');
    expect((init as any).headers.Authorization).toMatch(/^Bearer signed\.123\./);
  });

  it('returns the cached token within the TTL margin', async () => {
    fetchMock.mockResolvedValueOnce(mintResponse('inst-token-1', 3600));

    const a = await getInstallationToken(baseCreds);
    const b = await getInstallationToken(baseCreds);

    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-mints when the cached token is within the 5-minute refresh window', async () => {
    fetchMock
      .mockResolvedValueOnce(mintResponse('inst-token-1', 200))
      .mockResolvedValueOnce(mintResponse('inst-token-2', 3600));

    const first = await getInstallationToken(baseCreds);
    const second = await getInstallationToken(baseCreds);

    expect(first).toBe('inst-token-1');
    expect(second).toBe('inst-token-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight mint across concurrent callers', async () => {
    let resolveMint!: (value: any) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveMint = resolve;
      }),
    );

    const p1 = getInstallationToken(baseCreds);
    const p2 = getInstallationToken(baseCreds);

    resolveMint(mintResponse('inst-token-1', 3600));

    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe('inst-token-1');
    expect(b).toBe('inst-token-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('propagates a clear error on 401/403', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => 'Bad credentials',
    });

    await expect(getInstallationToken(baseCreds)).rejects.toThrow(/HTTP 401/);
  });

  it('decodes a base64-encoded private key', async () => {
    fetchMock.mockResolvedValueOnce(mintResponse('inst-token-1', 3600));

    await getInstallationToken({ ...baseCreds, privateKey: base64Pem });

    expect(signCalls).toHaveLength(1);
    expect(signCalls[0].key).toBe(fakePem);
  });

  it('passes through a raw PEM private key untouched', async () => {
    fetchMock.mockResolvedValueOnce(mintResponse('inst-token-1', 3600));

    await getInstallationToken(baseCreds);

    expect(signCalls[0].key).toBe(fakePem);
  });
});
