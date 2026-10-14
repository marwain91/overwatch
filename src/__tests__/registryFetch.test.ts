import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchNoRedirect } from '../adapters/registry/safeFetch';
import { GitLabAdapter } from '../adapters/registry/gitlab';
import { GHCRAdapter } from '../adapters/registry/ghcr';
import { DockerHubAdapter } from '../adapters/registry/dockerhub';
import { CustomRegistryAdapter } from '../adapters/registry/custom';
import { validateRegistryUrl } from '../adapters/registry/urlValidation';
import dns from 'dns';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.OVERWATCH_ALLOW_PRIVATE_REGISTRY_URL;
});

const redirect = () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } });

describe('registry fetches never follow redirects', () => {
  it('fetchNoRedirect sets redirect: manual and rejects a 3xx', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(redirect());
    await expect(fetchNoRedirect('https://x.test/')).rejects.toThrow(/redirect/i);
    expect(f.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('fetchNoRedirect passes non-redirect responses through', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    expect((await fetchNoRedirect('https://x.test/')).status).toBe(200);
  });

  it('GHCR, Docker Hub and custom adapters request with redirect: manual', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any);
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => redirect());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(new GHCRAdapter({ repository: 'o/r', token: 't' } as any).getImageTags()).rejects.toThrow(/redirect/i);
    expect(await new DockerHubAdapter({ repository: 'o/r' } as any).getImageTags()).toEqual([]);
    expect(await new CustomRegistryAdapter({ repository: 'o/r', url: 'reg.example.com' } as any).getImageTags()).toEqual([]);
    expect(f).toHaveBeenCalledTimes(3);
    for (const call of f.mock.calls) expect(call[1]).toMatchObject({ redirect: 'manual' });
  });

  it('GitLab adapter requests with redirect: manual and fails on 3xx', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any);
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => redirect());
    await expect(new GitLabAdapter({ repository: 'g/p', token: 't', apiUrl: 'https://gitlab.example.com' } as any).getImageTags()).rejects.toThrow(/redirect/i);
    expect(f.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });
});

describe('validateRegistryUrl', () => {
  it('rejects a registry whose AAAA record is private', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 }, { address: 'fd00::1', family: 6 },
    ] as any);
    await expect(validateRegistryUrl('reg.example.com')).rejects.toThrow(/private/);
  });

  it('accepts bare host:port and honours OVERWATCH_ALLOW_PRIVATE_REGISTRY_URL', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '10.1.1.1', family: 4 }] as any);
    await expect(validateRegistryUrl('registry.lan:5000')).rejects.toThrow(/private/);
    process.env.OVERWATCH_ALLOW_PRIVATE_REGISTRY_URL = '1';
    await expect(validateRegistryUrl('registry.lan:5000')).resolves.toBeUndefined();
  });
});
