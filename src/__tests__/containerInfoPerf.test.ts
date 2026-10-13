import { describe, it, expect, vi, afterEach } from 'vitest';
import { extractContainerInfo } from '../services/docker';

afterEach(() => vi.restoreAllMocks());

const apps = [
  { id: 'a', services: [{ name: 'web' }, { name: 'web-api' }] },
  { id: 'a-long', services: [{ name: 'worker' }] },
] as any;

describe('extractContainerInfo with known apps', () => {
  it('still resolves longest app and service first', () => {
    expect(extractContainerInfo('a-long-t1-worker', {}, apps)).toEqual({ appId: 'a-long', tenantId: 't1', service: 'worker' });
    expect(extractContainerInfo('a-t1-web-api', {}, apps)).toEqual({ appId: 'a', tenantId: 't1', service: 'web-api' });
  });

  it('sorts the apps and services once per apps array, not per container', () => {
    const sort = vi.spyOn(Array.prototype, 'sort');
    for (let i = 0; i < 50; i++) extractContainerInfo(`a-t${i}-web`, {}, apps);
    expect(sort.mock.calls.length).toBeLessThanOrEqual(3);
  });
});
