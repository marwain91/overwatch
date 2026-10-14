import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-startup-'));
  vi.doMock('../config', () => ({ getAppsDir: () => path.join(root, 'apps'), getDataDir: () => path.join(root, 'data') }));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  vi.resetModules();
  vi.doUnmock('../config');
});

describe('backfillComposeProjectNames', () => {
  it('adds COMPOSE_PROJECT_NAME to tenants lacking it, before the identification header, and is idempotent', async () => {
    const a = path.join(root, 'apps', 'acme', 'tenants', 'one');
    const b = path.join(root, 'apps', 'acme', 'tenants', 'two');
    await fs.mkdir(a, { recursive: true });
    await fs.mkdir(b, { recursive: true });
    await fs.writeFile(path.join(a, '.env'), '# App Identification\nAPP_ID=acme\n');
    await fs.writeFile(path.join(b, '.env'), 'COMPOSE_PROJECT_NAME=custom\nAPP_ID=acme\n');
    await fs.mkdir(path.join(root, 'apps', 'acme', 'tenants', 'no-env'), { recursive: true });

    const { backfillComposeProjectNames } = await import('../services/startupMaintenance');
    expect(await backfillComposeProjectNames()).toBe(1);
    const written = await fs.readFile(path.join(a, '.env'), 'utf-8');
    expect(written).toContain('COMPOSE_PROJECT_NAME=acme-one\n\n# App Identification');
    expect((await fs.stat(path.join(a, '.env'))).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(path.join(b, '.env'), 'utf-8')).toContain('COMPOSE_PROJECT_NAME=custom');
    expect(await backfillComposeProjectNames()).toBe(0);
  });

  it('returns 0 when there is no apps directory', async () => {
    const { backfillComposeProjectNames } = await import('../services/startupMaintenance');
    expect(await backfillComposeProjectNames()).toBe(0);
  });
});

describe('tightenSecretFilePermissions', () => {
  it('does not follow a symlinked tenant dir out of the apps dir', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-outside-'));
    try {
      await fs.writeFile(path.join(outside, '.env'), 'X=1', { mode: 0o644 });
      await fs.mkdir(path.join(root, 'apps', 'acme', 'tenants'), { recursive: true });
      await fs.symlink(outside, path.join(root, 'apps', 'acme', 'tenants', 'linked'));
      const { tightenSecretFilePermissions } = await import('../services/startupMaintenance');
      expect(await tightenSecretFilePermissions()).toBe(0);
      expect((await fs.stat(path.join(outside, '.env'))).mode & 0o777).toBe(0o644);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('logs and continues when one tenant file cannot be tightened', async () => {
    const a = path.join(root, 'apps', 'acme', 'tenants', 'bad');
    const b = path.join(root, 'apps', 'acme', 'tenants', 'good');
    for (const d of [a, b]) {
      await fs.mkdir(d, { recursive: true });
      await fs.writeFile(path.join(d, '.env'), 'X=1', { mode: 0o644 });
    }
    vi.doMock('fs/promises', async () => {
      const real = await vi.importActual<typeof import('fs/promises')>('fs/promises');
      const stat = (async (p: any, ...rest: any[]) => {
        if (String(p).includes(path.join('bad', '.env'))) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return (real.stat as any)(p, ...rest);
      }) as typeof real.stat;
      return { ...real, stat, default: { ...real, stat } };
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { tightenSecretFilePermissions } = await import('../services/startupMaintenance');
    const count = await tightenSecretFilePermissions();
    expect(count).toBe(1);
    expect((await fs.stat(path.join(b, '.env'))).mode & 0o777).toBe(0o600);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('[startup]'));
    err.mockRestore();
    vi.doUnmock('fs/promises');
  });
});
