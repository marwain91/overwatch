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
