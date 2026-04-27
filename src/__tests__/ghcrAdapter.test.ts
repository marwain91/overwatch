import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const spawnSyncMock = vi.fn();
vi.mock('child_process', () => ({
  spawnSync: (...args: any[]) => spawnSyncMock(...args),
}));

const getInstallationTokenMock = vi.fn();
vi.mock('../services/githubApp', () => ({
  getInstallationToken: (...args: any[]) => getInstallationTokenMock(...args),
}));

import { GHCRAdapter } from '../adapters/registry/ghcr';

const fetchMock = vi.fn();

describe('GHCRAdapter — PAT (token) auth path', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    getInstallationTokenMock.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('docker login uses the static token', async () => {
    spawnSyncMock.mockReturnValue({ status: 0, stderr: Buffer.from('') });
    const adapter = new GHCRAdapter({
      type: 'ghcr', url: 'ghcr.io', repository: 'org/repo', token: 'pat_abc',
    });

    await adapter.login();

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const [, args, opts] = spawnSyncMock.mock.calls[0];
    expect(args).toEqual(['login', 'ghcr.io', '-u', 'x-access-token', '--password-stdin']);
    expect(opts.input).toBe('pat_abc');
    expect(getInstallationTokenMock).not.toHaveBeenCalled();
  });

  it('tag listing sends the static token as Bearer', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => [{ name: 'v1.0.0' }, { name: 'v0.9.0' }],
    });
    const adapter = new GHCRAdapter({
      type: 'ghcr', url: 'ghcr.io', repository: 'org/repo', token: 'pat_abc',
    });

    const tags = await adapter.getImageTags();

    expect(tags).toEqual(['v1.0.0', 'v0.9.0']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect((init as any).headers.Authorization).toBe('Bearer pat_abc');
    expect(getInstallationTokenMock).not.toHaveBeenCalled();
  });
});

describe('GHCRAdapter — github_app auth path', () => {
  const githubApp = { appId: '123', installationId: '999', privateKey: '-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----' };

  beforeEach(() => {
    spawnSyncMock.mockReset();
    getInstallationTokenMock.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('docker login mints a fresh installation token and pipes it as the password', async () => {
    getInstallationTokenMock.mockResolvedValue('ghs_minted_token');
    spawnSyncMock.mockReturnValue({ status: 0, stderr: Buffer.from('') });
    const adapter = new GHCRAdapter({
      type: 'ghcr', url: 'ghcr.io', repository: 'org/repo', githubApp,
    });

    await adapter.login();

    expect(getInstallationTokenMock).toHaveBeenCalledTimes(1);
    expect(getInstallationTokenMock).toHaveBeenCalledWith(githubApp);
    const [, args, opts] = spawnSyncMock.mock.calls[0];
    expect(args).toEqual(['login', 'ghcr.io', '-u', 'x-access-token', '--password-stdin']);
    expect(opts.input).toBe('ghs_minted_token');
  });

  it('tag listing mints a fresh installation token and uses it as Bearer', async () => {
    getInstallationTokenMock.mockResolvedValue('ghs_minted_token');
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => [{ name: 'v2.0.0' }],
    });
    const adapter = new GHCRAdapter({
      type: 'ghcr', url: 'ghcr.io', repository: 'org/repo', githubApp,
    });

    const tags = await adapter.getImageTags();

    expect(tags).toEqual(['v2.0.0']);
    expect(getInstallationTokenMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/org/repo/tags?per_page=100');
    expect((init as any).headers.Authorization).toBe('Bearer ghs_minted_token');
  });

  it('401 error message references GitHub App permissions, not PAT scope', async () => {
    getInstallationTokenMock.mockResolvedValue('ghs_minted_token');
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });
    const adapter = new GHCRAdapter({
      type: 'ghcr', url: 'ghcr.io', repository: 'org/repo', githubApp,
    });

    await expect(adapter.getImageTags()).rejects.toThrow(/GitHub App.*Contents:Read/);
  });
});
