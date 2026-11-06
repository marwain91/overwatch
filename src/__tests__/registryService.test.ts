import { describe, it, expect, afterEach, vi } from 'vitest';
import { listImageTags, MAX_TAG_PAGES, RegistryHttpError } from '../services/registry';

afterEach(() => vi.restoreAllMocks());

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers });
const redirect = () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } });

describe('registry service never follows redirects', () => {
  it('fails on a redirect from the token endpoint without following it', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => redirect());
    await expect(listImageTags('reg.example.com/o/r:1')).rejects.toThrow(/redirect/i);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('fails on a redirect from the tags endpoint', async () => {
    const f = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ token: 't' }))
      .mockResolvedValueOnce(redirect());
    await expect(listImageTags('reg.example.com/o/r:1')).rejects.toThrow(/redirect/i);
    expect(f).toHaveBeenCalledTimes(2);
    expect(f.mock.calls[1][1]).toMatchObject({ redirect: 'manual' });
  });

  it('does not follow a Link: next to a foreign origin, but follows same-origin and relative links', async () => {
    const f = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ token: 't' }))
      .mockResolvedValueOnce(json({ tags: ['a'] }, { link: '</v2/o/r/tags/list?last=a>; rel="next"' }))
      .mockResolvedValueOnce(json({ tags: ['b'] }, { link: '<https://reg.example.com/v2/o/r/tags/list?last=b>; rel="next"' }))
      .mockResolvedValueOnce(json({ tags: ['c'] }, { link: '<https://evil.test/steal>; rel="next"' }));
    expect(await listImageTags('reg.example.com/o/r:1')).toEqual(['a', 'b', 'c']);
    expect(f).toHaveBeenCalledTimes(4);
    expect(f.mock.calls.some(c => String(c[0]).includes('evil.test'))).toBe(false);
  });

  it('matches an absolute next link by origin when the registry carries an explicit default port', async () => {
    const f = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ token: 't' }))
      .mockResolvedValueOnce(json({ tags: ['a'] }, { link: '<https://reg.example.com/v2/o/r/tags/list?last=a>; rel="next"' }))
      .mockResolvedValueOnce(json({ tags: ['b'] }));
    expect(await listImageTags('reg.example.com:443/o/r:1')).toEqual(['a', 'b']);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('does not treat a different port or scheme as the same origin', async () => {
    const f = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ token: 't' }))
      .mockResolvedValueOnce(json({ tags: ['a'] }, { link: '<https://reg.example.com:8443/v2/o/r/tags/list?last=a>; rel="next"' }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await listImageTags('reg.example.com/o/r:1')).toEqual(['a']);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('logs once when a foreign-origin next link is dropped, without the URL', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ token: 't' }))
      .mockResolvedValueOnce(json({ tags: ['a'] }, { link: '<https://evil.test/steal?key=SECRET>; rel="next"' }));
    expect(await listImageTags('reg.example.com/o/r:1')).toEqual(['a']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/Ignoring Link: next/);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET');
  });
});

describe('registry service credentials and errors', () => {
  it('sends explicit credentials to the token endpoint only', async () => {
    const f = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ token: 't' }))
      .mockResolvedValueOnce(json({ tags: ['a'] }));
    expect(await listImageTags('reg.example.com/o/r', { user: 'u', token: 'pat' })).toEqual(['a']);
    expect((f.mock.calls[0][1] as any).headers.Authorization).toBe(`Basic ${Buffer.from('u:pat').toString('base64')}`);
    expect((f.mock.calls[1][1] as any).headers.Authorization).toBe('Bearer t');
  });

  it('lists anonymously when credentials are null', async () => {
    const f = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ token: 't' }))
      .mockResolvedValueOnce(json({ tags: [] }));
    expect(await listImageTags('reg.example.com/o/r', null)).toEqual([]);
    expect((f.mock.calls[0][1] as any).headers.Authorization).toBeUndefined();
  });

  it.each([
    ['token exchange', [new Response('{}', { status: 403 })], 403],
    ['tag list', [json({ token: 't' }), new Response('{}', { status: 404 })], 404],
  ])('throws a RegistryHttpError with the status when the %s fails', async (_label, responses, status) => {
    const f = vi.spyOn(globalThis, 'fetch');
    for (const r of responses) f.mockResolvedValueOnce(r);
    const error = await listImageTags('reg.example.com/o/r', null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RegistryHttpError);
    expect((error as RegistryHttpError).status).toBe(status);
    expect(String(error)).toContain(`(HTTP ${status})`);
  });

  it('bounds every request with a timeout', async () => {
    const f = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ token: 't' }))
      .mockResolvedValueOnce(json({ tags: ['a'] }));
    await listImageTags('reg.example.com/o/r', null);
    for (const call of f.mock.calls) expect((call[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it('fails when a next link points back at a page it already read', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ token: 't' }))
      .mockResolvedValueOnce(json({ tags: ['a'] }, { link: '</v2/o/r/tags/list?last=a>; rel="next"' }))
      .mockResolvedValueOnce(json({ tags: ['b'] }, { link: '</v2/o/r/tags/list?last=a>; rel="next"' }));
    await expect(listImageTags('reg.example.com/o/r', null)).rejects.toThrow(/did not end after 2 pages/);
  });

  it(`stops after ${MAX_TAG_PAGES} pages`, async () => {
    let page = 0;
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/token')) return json({ token: 't' });
      page += 1;
      return json({ tags: [`t${page}`] }, { link: `</v2/o/r/tags/list?last=t${page}>; rel="next"` });
    });
    await expect(listImageTags('reg.example.com/o/r', null)).rejects.toThrow(new RegExp(`did not end after ${MAX_TAG_PAGES} pages`));
    expect(f).toHaveBeenCalledTimes(MAX_TAG_PAGES + 1);
  });
});
