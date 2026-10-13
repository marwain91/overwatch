import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let root: string;
let appsDir: string;
let dataDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-regen-'));
  appsDir = path.join(root, 'apps');
  dataDir = path.join(root, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  vi.doMock('../config', () => ({ getAppsDir: () => appsDir, getDataDir: () => dataDir }));
});

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock('../config');
  await fs.rm(root, { recursive: true, force: true });
});

async function tenant(app: string, id: string, withEnv = true) {
  const p = path.join(appsDir, app, 'tenants', id);
  await fs.mkdir(p, { recursive: true });
  if (withEnv) await fs.writeFile(path.join(p, '.env'), 'TENANT_DOMAIN=x\n');
  return p;
}

describe('regenerateAllSharedEnvFiles', () => {
  it('skips directories without .env and apps without a tenants dir', async () => {
    await tenant('demo', 'a');
    await tenant('demo', 'not-a-tenant', false);
    await fs.mkdir(path.join(appsDir, 'empty'), { recursive: true });
    const { regenerateAllSharedEnvFiles } = await import('../services/envVars');
    expect(await regenerateAllSharedEnvFiles()).toBe(1);
    await expect(fs.access(path.join(appsDir, 'demo', 'tenants', 'a', 'shared.env'))).resolves.toBeUndefined();
  });

  it('throws after the loop naming the failing tenants, without paths, and still regenerates the others', async () => {
    await tenant('demo', 'ok-one');
    const bad = await tenant('demo', 'bad-one');
    await fs.mkdir(path.join(bad, 'shared.env')); // write target is a directory
    await tenant('demo', 'ok-two');
    const { regenerateAllSharedEnvFiles, SharedEnvRegenerationError } = await import('../services/envVars');

    const err: any = await regenerateAllSharedEnvFiles('demo').catch(e => e);

    expect(err).toBeInstanceOf(SharedEnvRegenerationError);
    expect(err.status).toBe(500);
    expect(err.expose).toBe(true);
    expect(err.failures.map((f: any) => `${f.appId}/${f.tenantId}`)).toEqual(['demo/bad-one']);
    expect(err.clientMessage).toContain('demo/bad-one');
    expect(err.clientMessage).not.toContain(root);
    for (const id of ['ok-one', 'ok-two']) {
      await expect(fs.access(path.join(appsDir, 'demo', 'tenants', id, 'shared.env'))).resolves.toBeUndefined();
    }
  });

  it('collects a tenants-dir read failure for one app and still sweeps the others', async () => {
    await tenant('good', 'a');
    await fs.mkdir(path.join(appsDir, 'broken'), { recursive: true });
    await fs.chmod(path.join(appsDir, 'broken'), 0o000);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { regenerateAllSharedEnvFiles } = await import('../services/envVars');
    const err: any = await regenerateAllSharedEnvFiles().catch(e => e);
    await fs.chmod(path.join(appsDir, 'broken'), 0o755);
    if (process.getuid?.() === 0) return; // root ignores modes
    expect(err.failures.map((f: any) => f.appId)).toEqual(['broken']);
    await expect(fs.access(path.join(appsDir, 'good', 'tenants', 'a', 'shared.env'))).resolves.toBeUndefined();
  });
});
