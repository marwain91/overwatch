import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-reserved-'));
  await fs.mkdir(path.join(dir, 'apps.d'));
});
afterEach(async () => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock('../config');
  vi.doUnmock('../config/loader');
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeApp(id: string, secretEnv: string) {
  await fs.writeFile(path.join(dir, 'apps.d', `${id}.json`), JSON.stringify({
    id, name: id, domain_template: `*.${id}.example`,
    services: [{ name: 'web', image_suffix: 'web', ports: { internal: 80 } }],
    registry: { type: 'ghcr', url: 'ghcr.io', repository: 'o/r', auth: { type: 'token', token_env: 'X' } },
    admin_access: { enabled: true, secret_env: secretEnv },
  }));
}

describe('app load warning for reserved secret env', () => {
  it('warns once per app and still loads the definition', async () => {
    vi.doMock('../config', async (orig) => ({ ...(await orig<any>()), getDataDir: () => dir }));
    vi.doMock('../config/loader', async (orig) => ({ ...(await orig<any>()), loadConfig: () => ({ database: { root_password_env: 'MYSQL_ROOT_PASSWORD' } }) }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await writeApp('bad', 'JWT_SECRET');
    await writeApp('good', 'AUTH_SERVICE_SECRET');
    const { listApps } = await import('../services/app');
    const apps = await listApps();
    await listApps();
    expect(apps.map(a => a.id).sort()).toEqual(['bad', 'good']);
    const msgs = warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('JWT_SECRET'));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('bad');
    expect(warn.mock.calls.map(c => String(c[0])).some(m => m.includes("'good'"))).toBe(false);
  });
});
