import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const spawnSyncMock = vi.fn();
vi.mock('child_process', () => ({
  spawnSync: (...args: any[]) => spawnSyncMock(...args),
}));

const validateRegistryUrlMock = vi.fn();
vi.mock('../adapters/registry/urlValidation', () => ({
  validateRegistryUrl: (...args: any[]) => validateRegistryUrlMock(...args),
}));

import { GitLabAdapter } from '../adapters/registry/gitlab';

const fetchMock = vi.fn();

const baseSaaS = {
  type: 'gitlab' as const,
  url: 'registry.gitlab.com',
  repository: 'mygroup/myproject',
  token: 'glpat_abc',
};

const baseSelfHosted = {
  type: 'gitlab' as const,
  url: 'registry.acme.com:5050',
  apiUrl: 'https://gitlab.acme.com',
  repository: 'group/sub/project',
  token: 'glpat_xyz',
};

describe('GitLabAdapter — login()', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    fetchMock.mockReset();
    validateRegistryUrlMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shells out with -u oauth2 and pipes the token via --password-stdin', async () => {
    spawnSyncMock.mockReturnValue({ status: 0, stderr: Buffer.from('') });
    const adapter = new GitLabAdapter(baseSaaS);

    await adapter.login();

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnSyncMock.mock.calls[0];
    expect(cmd).toBe('docker');
    expect(args).toEqual(['login', 'registry.gitlab.com', '-u', 'oauth2', '--password-stdin']);
    expect(opts.input).toBe('glpat_abc');
  });

  it('uses the operator-supplied registry URL on self-hosted', async () => {
    spawnSyncMock.mockReturnValue({ status: 0, stderr: Buffer.from('') });
    const adapter = new GitLabAdapter(baseSelfHosted);

    await adapter.login();

    const [, args] = spawnSyncMock.mock.calls[0];
    expect(args).toEqual(['login', 'registry.acme.com:5050', '-u', 'oauth2', '--password-stdin']);
  });

  it('skips login (does not throw) when no token is configured', async () => {
    const adapter = new GitLabAdapter({ ...baseSaaS, token: undefined });

    await expect(adapter.login()).resolves.toBeUndefined();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('propagates docker login failures', async () => {
    spawnSyncMock.mockReturnValue({ status: 1, stderr: Buffer.from('unauthorized') });
    const adapter = new GitLabAdapter(baseSaaS);

    await expect(adapter.login()).rejects.toThrow(/unauthorized/);
  });
});

describe('GitLabAdapter — getImageTags()', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    fetchMock.mockReset();
    validateRegistryUrlMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function tagsResponse(names: string[]) {
    return {
      ok: true,
      status: 200,
      json: async () => names.map((name) => ({ name })),
      text: async () => '',
    };
  }

  it('hits gitlab.com when SaaS, with URL-encoded project path', async () => {
    fetchMock.mockResolvedValueOnce(tagsResponse(['v1.0.0', 'v0.9.0']));
    const adapter = new GitLabAdapter(baseSaaS);

    const tags = await adapter.getImageTags();

    expect(tags).toEqual(['v1.0.0', 'v0.9.0']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://gitlab.com/api/v4/projects/mygroup%2Fmyproject/repository/tags?per_page=100&order_by=name&sort=desc',
    );
    expect((init as any).headers['PRIVATE-TOKEN']).toBe('glpat_abc');
    // SaaS path: derived gitlab.com is trusted, no SSRF check.
    expect(validateRegistryUrlMock).not.toHaveBeenCalled();
  });

  it('uses api_url and SSRF-checks it on self-hosted', async () => {
    validateRegistryUrlMock.mockResolvedValue(undefined);
    fetchMock.mockResolvedValueOnce(tagsResponse(['v2.0.0']));
    const adapter = new GitLabAdapter(baseSelfHosted);

    const tags = await adapter.getImageTags();

    expect(tags).toEqual(['v2.0.0']);
    expect(validateRegistryUrlMock).toHaveBeenCalledTimes(1);
    expect(validateRegistryUrlMock).toHaveBeenCalledWith('https://gitlab.acme.com');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://gitlab.acme.com/api/v4/projects/group%2Fsub%2Fproject/repository/tags?per_page=100&order_by=name&sort=desc',
    );
    expect((init as any).headers['PRIVATE-TOKEN']).toBe('glpat_xyz');
  });

  it('strips a trailing slash from api_url', async () => {
    validateRegistryUrlMock.mockResolvedValue(undefined);
    fetchMock.mockResolvedValueOnce(tagsResponse(['v1']));
    const adapter = new GitLabAdapter({ ...baseSelfHosted, apiUrl: 'https://gitlab.acme.com/' });

    await adapter.getImageTags();

    const [url] = fetchMock.mock.calls[0];
    expect(url).toMatch(/^https:\/\/gitlab\.acme\.com\/api\/v4/);
  });

  it('throws "needs an api_url" before any network call when self-hosted with no api_url', async () => {
    const adapter = new GitLabAdapter({
      type: 'gitlab', url: 'registry.acme.com:5050', repository: 'g/p', token: 't',
    });

    await expect(adapter.getImageTags()).rejects.toThrow(/needs an api_url/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(validateRegistryUrlMock).not.toHaveBeenCalled();
  });

  it('401 message references read_api scope and Group AT', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}), text: async () => '' });
    const adapter = new GitLabAdapter(baseSaaS);

    await expect(adapter.getImageTags()).rejects.toThrow(/read_api.*Group/s);
  });

  it('404 message names the project and the API base', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
    const adapter = new GitLabAdapter(baseSaaS);

    await expect(adapter.getImageTags()).rejects.toThrow(/mygroup\/myproject.*gitlab\.com/s);
  });

  it('applies tag pattern filter and re-sorts client-side', async () => {
    fetchMock.mockResolvedValueOnce(tagsResponse(['v1.10.0', 'v1.9.0', 'v1.2.0', 'release-2024-01-01']));
    const adapter = new GitLabAdapter({
      ...baseSaaS,
      tagPattern: /^v\d/,
    });

    const tags = await adapter.getImageTags();

    expect(tags).toEqual(['v1.10.0', 'v1.9.0', 'v1.2.0']);
  });

  it('throws when no token is configured', async () => {
    const adapter = new GitLabAdapter({ ...baseSaaS, token: undefined });
    await expect(adapter.getImageTags()).rejects.toThrow(/token not configured/);
  });
});

describe('GitLabAdapter — getImageRef', () => {
  it('composes registry/repository/service:tag', () => {
    const adapter = new GitLabAdapter(baseSelfHosted);
    expect(adapter.getImageRef('backend', 'v1.0.0')).toBe(
      'registry.acme.com:5050/group/sub/project/backend:v1.0.0',
    );
  });
});
