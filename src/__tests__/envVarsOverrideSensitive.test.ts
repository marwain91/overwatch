import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

let tmpRoot: string;

beforeEach(async () => {
  vi.resetModules();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-override-sensitive-'));
  vi.doMock('../config', () => ({ getDataDir: () => tmpRoot, getAppsDir: () => path.join(tmpRoot, 'apps') }));
  await fs.writeFile(path.join(tmpRoot, 'env-vars.json'), JSON.stringify({
    demo: [
      { key: 'API_TOKEN', value: 'global-secret', sensitive: true, createdAt: 'x', updatedAt: 'x' },
      { key: 'LOG_LEVEL', value: 'info', sensitive: false, createdAt: 'x', updatedAt: 'x' },
    ],
  }));
});

afterEach(async () => {
  vi.doUnmock('../config');
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function effective(key: string) {
  const { getEffectiveEnvVars } = await import('../services/envVars');
  return (await getEffectiveEnvVars('demo', 't1')).find(v => v.key === key)!;
}

describe('setTenantOverride sensitive flag', () => {
  it('keeps an existing sensitive override sensitive when an edit omits the flag', async () => {
    const { setTenantOverride } = await import('../services/envVars');
    await setTenantOverride('demo', 't1', 'TENANT_SECRET', 'one', true);
    await setTenantOverride('demo', 't1', 'TENANT_SECRET', 'two');
    expect(await effective('TENANT_SECRET')).toMatchObject({ value: 'two', sensitive: true });
  });

  it('a new override of a sensitive global variable inherits the flag', async () => {
    const { setTenantOverride } = await import('../services/envVars');
    await setTenantOverride('demo', 't1', 'API_TOKEN', 'tenant-secret');
    expect(await effective('API_TOKEN')).toMatchObject({ source: 'override', sensitive: true });
  });

  it('an explicit flag still wins, and a plain variable stays plain', async () => {
    const { setTenantOverride } = await import('../services/envVars');
    await setTenantOverride('demo', 't1', 'API_TOKEN', 'v', false);
    await setTenantOverride('demo', 't1', 'LOG_LEVEL', 'debug');
    expect((await effective('API_TOKEN')).sensitive).toBe(false);
    expect((await effective('LOG_LEVEL')).sensitive).toBe(false);
  });
});
