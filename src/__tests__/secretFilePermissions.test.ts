import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { writeSecretFile } from '../utils/security';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-secrets-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
});

describe('writeSecretFile', () => {
  it('creates a new file with mode 0600', async () => {
    const target = path.join(tmpRoot, 'new.env');
    await writeSecretFile(target, 'SECRET=value\n');
    const stat = await fs.stat(target);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('tightens an existing world-readable file to 0600', async () => {
    const target = path.join(tmpRoot, 'pre-existing.env');
    await fs.writeFile(target, 'old=value', { mode: 0o644 });
    expect((await fs.stat(target)).mode & 0o777).toBe(0o644);
    await writeSecretFile(target, 'new=value');
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
  });
});

describe('envVars secret-file generation is 0600', () => {
  it('generateSharedEnvFile writes shared.env with mode 0600', async () => {
    const appsDir = path.join(tmpRoot, 'apps');
    const dataDir = path.join(tmpRoot, 'data');
    const tenantDir = path.join(appsDir, 'myapp', 'tenants', 't1');
    await fs.mkdir(tenantDir, { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });

    vi.doMock('../config', () => ({
      getAppsDir: () => appsDir,
      getDataDir: () => dataDir,
    }));
    vi.doMock('./fileLock', () => ({
      withFileLock: <T>(_name: string, fn: () => Promise<T>) => fn(),
    }));

    const { generateSharedEnvFile, setEnvVar } = await import('../services/envVars');

    await setEnvVar('myapp', 'MY_SECRET', 'hunter2', true);
    // the json store itself must be 0600
    expect((await fs.stat(path.join(dataDir, 'env-vars.json'))).mode & 0o777).toBe(0o600);

    await generateSharedEnvFile('myapp', 't1');
    const sharedStat = await fs.stat(path.join(tenantDir, 'shared.env'));
    expect(sharedStat.mode & 0o777).toBe(0o600);
  });
});

describe('tightenSecretFilePermissions migration', () => {
  it('chmod 0600 on pre-existing loose secret files and returns count', async () => {
    const appsDir = path.join(tmpRoot, 'apps');
    const dataDir = path.join(tmpRoot, 'data');
    const tenantDir = path.join(appsDir, 'myapp', 'tenants', 't1');
    await fs.mkdir(tenantDir, { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });

    await fs.writeFile(path.join(tenantDir, '.env'), 'DB_PASSWORD=a', { mode: 0o644 });
    await fs.writeFile(path.join(tenantDir, 'shared.env'), 'X=1', { mode: 0o644 });
    await fs.writeFile(path.join(dataDir, 'env-vars.json'), '{}', { mode: 0o644 });
    await fs.writeFile(path.join(dataDir, 'notification-channels.json'), '[]', { mode: 0o644 });
    // Already-tight file should not count
    await fs.writeFile(path.join(dataDir, 'tenant-env-overrides.json'), '{}', { mode: 0o600 });

    vi.doMock('../config', () => ({
      getAppsDir: () => appsDir,
      getDataDir: () => dataDir,
    }));
    vi.doMock('./fileLock', () => ({
      withFileLock: <T>(_name: string, fn: () => Promise<T>) => fn(),
    }));

    const { tightenSecretFilePermissions } = await import('../services/envVars');
    const count = await tightenSecretFilePermissions();

    expect(count).toBe(4);
    expect((await fs.stat(path.join(tenantDir, '.env'))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.join(tenantDir, 'shared.env'))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.join(dataDir, 'env-vars.json'))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.join(dataDir, 'notification-channels.json'))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.join(dataDir, 'tenant-env-overrides.json'))).mode & 0o777).toBe(0o600);
  });
});
