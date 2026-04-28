import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const spawnSyncMock = vi.fn();
vi.mock('child_process', () => ({
  spawnSync: (...args: any[]) => spawnSyncMock(...args),
}));

import { GHCRAdapter } from '../adapters/registry/ghcr';

const fetchMock = vi.fn();

describe('GHCRAdapter — PAT (token) auth path', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
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
  });

  it('skips docker login when no token is configured', async () => {
    const adapter = new GHCRAdapter({
      type: 'ghcr', url: 'ghcr.io', repository: 'org/repo',
    });
    await adapter.login();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('error message references PAT scope (no longer mentions GitHub App, removed in v1.6.7)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });
    const adapter = new GHCRAdapter({
      type: 'ghcr', url: 'ghcr.io', repository: 'org/repo', token: 'pat_abc',
    });
    await expect(adapter.getImageTags()).rejects.toThrow(/GHCR_TOKEN.*'repo' scope/);
  });
});
