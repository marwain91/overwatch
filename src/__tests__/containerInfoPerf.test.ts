import { describe, it, expect } from 'vitest';
import { extractContainerInfo } from '../services/docker';

const apps = [
  { id: 'a', services: [{ name: 'web' }, { name: 'web-api' }] },
  { id: 'a-long', services: [{ name: 'worker' }] },
] as any;

/** Apps whose id/services reads are counted, to see how often a lookup re-reads them. */
function countingApps() {
  const reads = { n: 0 };
  const wrapped = apps.map((app: any) => ({
    get id() { reads.n++; return app.id; },
    get services() { reads.n++; return app.services; },
  })) as any;
  return { wrapped, reads };
}

describe('extractContainerInfo with known apps', () => {
  it('still resolves longest app and service first', () => {
    expect(extractContainerInfo('a-long-t1-worker', {}, apps)).toEqual({ appId: 'a-long', tenantId: 't1', service: 'worker' });
    expect(extractContainerInfo('a-t1-web-api', {}, apps)).toEqual({ appId: 'a', tenantId: 't1', service: 'web-api' });
  });

  it('prepares an apps array once, not once per container', () => {
    const { wrapped, reads } = countingApps();
    extractContainerInfo('a-t0-web', {}, wrapped);
    const afterFirst = reads.n;
    expect(afterFirst).toBeGreaterThan(0);
    for (let i = 1; i < 50; i++) extractContainerInfo(`a-t${i}-web`, {}, wrapped);
    expect(reads.n).toBe(afterFirst); // later lookups work from the prepared copy

    // A different array (a new pass over fresh app data) is prepared again.
    const second = countingApps();
    extractContainerInfo('a-t1-web', {}, second.wrapped);
    expect(second.reads.n).toBe(afterFirst);
  });
});
