import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const runDockerMock = vi.fn();
vi.mock('../utils/runDocker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/runDocker')>()),
  runDocker: (...args: any[]) => runDockerMock(...args),
}));
const validateRegistryUrlMock = vi.fn();
vi.mock('../adapters/registry/urlValidation', () => ({
  validateRegistryUrl: (...args: any[]) => validateRegistryUrlMock(...args),
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GHCRAdapter } from '../adapters/registry/ghcr';
import { clearAdapterCache, getImageTagsForApp } from '../adapters/registry';
import { RegistryHttpError } from '../services/registry';

const fetchMock = vi.fn();

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

/**
 * A fake ghcr.io: `/token` hands out one bearer per image, `/v2/<image>/tags/list`
 * answers with that image's tags. A number instead of tags makes the token
 * exchange (or, as `{ list: n }`, the tag list) fail with that status.
 */
function registry(images: Record<string, string[] | number | { list: number }>) {
  fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (u.pathname === '/token') {
      const image = /^repository:(.+):pull$/.exec(u.searchParams.get('scope') ?? '')?.[1] ?? '';
      const entry = images[image];
      if (typeof entry === 'number') return new Response('{}', { status: entry });
      return json({ token: `bearer:${image}` });
    }
    const image = /^\/v2\/(.+)\/tags\/list$/.exec(u.pathname)?.[1] ?? '';
    const entry = images[image];
    if (entry === undefined || headers.Authorization !== `Bearer bearer:${image}`) {
      return new Response('{}', { status: 401 });
    }
    if (typeof entry === 'object' && !Array.isArray(entry)) return new Response('{}', { status: entry.list });
    return json({ name: image, tags: entry });
  });
}

const calledUrls = () => fetchMock.mock.calls.map((c) => String(c[0]));
const tokenCalls = () => fetchMock.mock.calls.filter((c) => new URL(String(c[0])).pathname === '/token');

const ghcr = (extra: Partial<ConstructorParameters<typeof GHCRAdapter>[0]> = {}) =>
  new GHCRAdapter({ type: 'ghcr', url: 'ghcr.io', repository: 'org/repo', token: 'pat_abc', ...extra });

beforeEach(() => {
  runDockerMock.mockReset();
  fetchMock.mockReset();
  validateRegistryUrlMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GHCRAdapter — docker login', () => {
  it('docker login uses the static token', async () => {
    runDockerMock.mockResolvedValue({ stdout: '', stderr: '' });

    await ghcr().login();

    expect(runDockerMock).toHaveBeenCalledTimes(1);
    const [, args, opts] = runDockerMock.mock.calls[0];
    expect(args).toEqual(['login', '--username=x-access-token', '--password-stdin', '--', 'ghcr.io']);
    expect(opts.input).toBe('pat_abc');
  });

  it('skips docker login when no token is configured', async () => {
    await ghcr({ token: undefined }).login();
    expect(runDockerMock).not.toHaveBeenCalled();
  });
});

describe('GHCRAdapter — tag listing from the registry', () => {
  it('lists only the tags every service image has, newest first, without calling the GitHub API', async () => {
    registry({
      'org/repo/backend': ['1.6.8', 'latest', '1.6.9', '1.6.10', 'canary-82'],
      'org/repo/frontend': ['1.6.9', 'latest', '1.6.8', 'canary-82', '1.7.0'],
    });

    const tags = await ghcr().getImageTags(['backend', 'frontend']);

    expect(tags).toEqual(['latest', '1.6.9', '1.6.8', 'canary-82']);
    expect(calledUrls().every((u) => u.startsWith('https://ghcr.io/'))).toBe(true);
    expect(validateRegistryUrlMock).not.toHaveBeenCalled();
  });

  it('authenticates the token exchange with the PAT, and the tag list only with the registry bearer', async () => {
    registry({ 'org/repo/backend': ['1.0.0'] });

    await ghcr().getImageTags(['backend']);

    const [exchange, list] = fetchMock.mock.calls;
    const basic = Buffer.from('x-access-token:pat_abc').toString('base64');
    expect((exchange[1] as any).headers.Authorization).toBe(`Basic ${basic}`);
    expect((list[1] as any).headers.Authorization).toBe('Bearer bearer:org/repo/backend');
    expect(JSON.stringify(list)).not.toContain('pat_abc');
  });

  it('uses the configured username for the token exchange', async () => {
    registry({ 'org/repo/backend': ['1.0.0'] });

    await ghcr({ username: 'svc-bot' }).getImageTags(['backend']);

    const basic = Buffer.from('svc-bot:pat_abc').toString('base64');
    expect((fetchMock.mock.calls[0][1] as any).headers.Authorization).toBe(`Basic ${basic}`);
  });

  it('applies tag_pattern to the common tags', async () => {
    registry({
      'org/repo/backend': ['latest', '1.2.0', 'v1.1.0', 'sha-abc'],
      'org/repo/web': ['latest', '1.2.0', 'v1.1.0', 'sha-abc'],
    });

    expect(await ghcr({ tagPattern: /^v?\d/ }).getImageTags(['backend', 'web'])).toEqual(['1.2.0', 'v1.1.0']);
  });

  it('lists each image once', async () => {
    registry({ 'org/repo/backend': ['1.0.0'] });

    expect(await ghcr().getImageTags(['backend', 'backend'])).toEqual(['1.0.0']);
    expect(tokenCalls()).toHaveLength(1);
    expect(new URL(String(tokenCalls()[0][0])).searchParams.get('scope')).toBe('repository:org/repo/backend:pull');
  });

  it.each([
    'x&service=ghcr.io&scope=repository:victim/secret:pull&/../../victim/secret/tags/list#',
    '../secret',
    'web#frag',
    'web?n=1',
    '-web',
    'web/',
    '',
  ])('refuses the image name %j before any request', async (bad) => {
    await expect(ghcr().getImageTags(['backend', bad])).rejects.toThrow(/not a registry path/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts multi-segment image names', async () => {
    registry({ 'org/repo/services/web': ['1.0.0'] });

    expect(await ghcr().getImageTags(['services/web'])).toEqual(['1.0.0']);
  });

  it('calls the configured host itself, also when it has no dot (never docker.io)', async () => {
    validateRegistryUrlMock.mockResolvedValue(undefined);
    fetchMock.mockImplementation(async () => new Response('{}', { status: 401 }));

    await expect(ghcr({ url: 'registry' }).getImageTags(['backend'])).rejects.toThrow(/denied access to registry\/org\/repo\/backend/);
    expect(validateRegistryUrlMock).toHaveBeenCalledWith('registry');
    expect(calledUrls()).toEqual(['https://registry/token?scope=repository:org/repo/backend:pull&service=registry']);
  });

  it('puts a path in the registry url in front of the repository', async () => {
    fetchMock.mockImplementation(async () => new Response('{}', { status: 401 }));

    await expect(ghcr({ url: 'ghcr.io/team' }).getImageTags(['backend'])).rejects.toThrow(/HTTP 401/);
    expect(calledUrls()).toEqual(['https://ghcr.io/token?scope=repository:team/org/repo/backend:pull&service=ghcr.io']);
  });

  describe('without a token', () => {
    const savedHome = process.env.HOME;
    let home: string;

    beforeEach(() => {
      // A docker login for ghcr.io that anonymous listing must not pick up.
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcr-home-'));
      fs.mkdirSync(path.join(home, '.docker'));
      const auth = Buffer.from('someone:other_pat').toString('base64');
      fs.writeFileSync(path.join(home, '.docker', 'config.json'), JSON.stringify({ auths: { 'ghcr.io': { auth } } }));
      process.env.HOME = home;
    });

    afterEach(() => {
      process.env.HOME = savedHome;
      fs.rmSync(home, { recursive: true, force: true });
    });

    it('lists public packages anonymously, ignoring docker logins', async () => {
      registry({ 'org/repo/backend': ['1.0.0'] });

      expect(await ghcr({ token: undefined }).getImageTags(['backend'])).toEqual(['1.0.0']);
      expect((fetchMock.mock.calls[0][1] as any).headers.Authorization).toBeUndefined();
    });

    it('says that no token is configured when GHCR refuses anonymous access', async () => {
      registry({ 'org/repo/backend': 401 });

      await expect(ghcr({ token: undefined }).getImageTags(['backend'])).rejects.toThrow(/HTTP 401\) without a token\. No registry token is configured/);
    });
  });

  it('passes other registry failures through with their status', async () => {
    registry({ 'org/repo/backend': { list: 502 } });

    const error = await ghcr().getImageTags(['backend']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RegistryHttpError);
    expect(String(error)).toMatch(/registry tag list failed \(HTTP 502\)/);
  });

  it.each([401, 403])('names read:packages, not the repo scope, when GHCR answers %i', async (status) => {
    registry({ 'org/repo/backend': status });

    const error = await ghcr().getImageTags(['backend']).catch((e: Error) => e);

    expect(String(error)).toMatch(new RegExp(`denied access to ghcr.io/org/repo/backend \\(HTTP ${status}\\).*'read:packages'`));
    expect(String(error)).not.toMatch(/'repo'/);
    expect(String(error)).not.toContain('pat_abc');
  });

  it('reports a missing package as not found', async () => {
    registry({ 'org/repo/backend': { list: 404 } });

    await expect(ghcr().getImageTags(['backend'])).rejects.toThrow(/ghcr.io\/org\/repo\/backend not found \(HTTP 404\)/);
  });

  it('refuses to list without service images', async () => {
    await expect(ghcr().getImageTags([])).rejects.toThrow(/No service images/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates an operator-supplied registry host before sending the token to it', async () => {
    validateRegistryUrlMock.mockRejectedValue(new Error('Registry URL resolves to a blocked address'));

    await expect(ghcr({ url: 'registry.internal.test' }).getImageTags(['backend'])).rejects.toThrow(/blocked address/);
    expect(validateRegistryUrlMock).toHaveBeenCalledWith('registry.internal.test');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getImageTagsForApp — GHCR', () => {
  afterEach(() => {
    clearAdapterCache();
    delete process.env.GHCR_TEST_TOKEN;
  });

  it("lists tags across the app's distinct service images (image_suffix, else the service name)", async () => {
    process.env.GHCR_TEST_TOKEN = 'pat_abc';
    registry({
      'org/repo/backend': ['2.0.0', '1.9.0'],
      'org/repo/web': ['2.0.0'],
    });
    const app = {
      id: 'demo',
      registry: { type: 'ghcr', url: 'ghcr.io', repository: 'org/repo', auth: { type: 'token', token_env: 'GHCR_TEST_TOKEN' } },
      services: [
        { name: 'api', image_suffix: 'backend' },
        { name: 'migrate', image_suffix: 'backend', is_init_container: true },
        { name: 'web' },
      ],
    } as any;

    expect(await getImageTagsForApp(app)).toEqual(['2.0.0']);
    expect(tokenCalls().map((c) => new URL(String(c[0])).searchParams.get('scope')).sort()).toEqual([
      'repository:org/repo/backend:pull',
      'repository:org/repo/web:pull',
    ]);
  });
});
