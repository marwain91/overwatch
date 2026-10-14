import { describe, it, expect, afterEach, vi } from 'vitest';
import { listImageTags } from '../services/registry';

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
