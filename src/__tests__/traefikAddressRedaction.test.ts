import { describe, it, expect } from 'vitest';
import { redactMiddlewareCredentials, restoreMiddlewareCredentials, redactRawLabels, restoreRawLabels, MASK } from '../services/traefikRedaction';

const LEAKS = [
  'https://a.example/v?next=https://u:pw@x/',
  'https://a.example/v?r=u%3Apw%40x',
  'https://a.example/v?a=1;token=abc',
  'https://a.example/v;jsessionid=abc?x=1',
  'https://a.example/u:pw@x/',
];
const typed = (address: string): any => ({ x: { type: 'forwardAuth', address } });
const viewerAddr = (a: string) => (redactMiddlewareCredentials(typed(a)) as any).x.address;
const LABEL = 'traefik.http.middlewares.x.forwardauth.address';

describe('forwardAuth address redaction keeps only the origin', () => {
  it.each(LEAKS)('masks everything after the origin of %s', (leak) => {
    expect(viewerAddr(leak)).toBe(`https://a.example/${MASK}`);
    expect(redactRawLabels({ [LABEL]: leak })[LABEL]).toBe(`https://a.example/${MASK}`);
  });

  it('drops userinfo, query and hash; keeps a bare origin and the port', () => {
    expect(viewerAddr('https://user:pw@auth.example/check?x=1')).toBe(`https://auth.example/${MASK}`);
    expect(viewerAddr('https://auth.example/')).toBe('https://auth.example/');
    expect(viewerAddr('http://auth.example:8080#f')).toBe(`http://auth.example:8080/${MASK}`);
    expect(viewerAddr('ftp://auth.example/')).toBe(MASK);
  });

  it('admin raw value is unchanged and an editor re-saving the masked form keeps the stored one', () => {
    for (const leak of LEAKS) {
      const stored = typed(leak);
      const masked = redactMiddlewareCredentials(stored) as any;
      expect(restoreMiddlewareCredentials(masked, stored)).toEqual(stored);
      expect(restoreRawLabels(redactRawLabels({ [LABEL]: leak }), { [LABEL]: leak })).toEqual({ [LABEL]: leak });
      expect(() => restoreMiddlewareCredentials(masked, undefined)).toThrow(/masked placeholder/);
    }
  });

  it('an editor sending a clean different URL persists it', () => {
    const stored = typed(LEAKS[0]);
    expect((restoreMiddlewareCredentials(typed('https://a.example/v2'), stored) as any).x.address).toBe('https://a.example/v2');
    expect(restoreRawLabels({ [LABEL]: 'https://b.example/c' }, { [LABEL]: LEAKS[0] })[LABEL]).toBe('https://b.example/c');
  });
});

describe('router-only reference exemption and rule matcher', () => {
  const leakRef = 'a;token=abc@docker';
  it('shows router middlewares/service in clear but masks chain/errors keys', () => {
    const out = redactRawLabels({
      'traefik.http.routers.r.middlewares': leakRef,
      'traefik.http.routers.r.service': leakRef,
      'traefik.http.middlewares.c.chain.middlewares': leakRef,
      'traefik.http.middlewares.e.errors.service': leakRef,
      'traefik.http.middlewares.c2.chain.middlewares': 'a@docker,b@file',
    });
    expect(out['traefik.http.routers.r.middlewares']).toBe(leakRef);
    expect(out['traefik.http.routers.r.service']).toBe(leakRef);
    expect(out['traefik.http.middlewares.c.chain.middlewares']).toBe(MASK);
    expect(out['traefik.http.middlewares.e.errors.service']).toBe(MASK);
    expect(out['traefik.http.middlewares.c2.chain.middlewares']).toBe(MASK);
  });

  it('masks a lowercase header( rule', () => {
    expect(redactRawLabels({ 'traefik.http.routers.r.rule': 'Host(`a.example`) && header(`X-K`, `s3`)' })['traefik.http.routers.r.rule']).toBe(MASK);
  });
});

describe('typed header map restore', () => {
  it('refuses a value that merely contains the placeholder', () => {
    const stored: any = { h: { type: 'headers', custom_request_headers: { Authorization: 'Bearer abc' } } };
    const bad: any = { h: { type: 'headers', custom_request_headers: { Authorization: `Bearer ${MASK}` } } };
    expect(() => restoreMiddlewareCredentials(bad, stored)).toThrow(/masked placeholder/);
    const ok: any = { h: { type: 'headers', custom_request_headers: { Authorization: MASK } } };
    expect(restoreMiddlewareCredentials(ok, stored)).toEqual(stored);
  });
});
