import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

let appsDir = '';
vi.mock('../config', () => ({
  getAppsDir: () => appsDir,
  resolveAppDbPrefix: (app?: { db_prefix?: string }) => (app && app.db_prefix !== undefined ? app.db_prefix : 'acme'),
}));

import { resolveTenantDbId } from '../services/tenantDb';

async function writeEnv(appId: string, tenantId: string, content: string) {
  const dir = path.join(appsDir, appId, 'tenants', tenantId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '.env'), content);
}

describe('resolveTenantDbId', () => {
  beforeEach(async () => { appsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tenantdb-')); });
  afterEach(async () => { await fs.rm(appsDir, { recursive: true, force: true }); });

  it('falls back to appId_tenantId without a DB_NAME', async () => {
    await writeEnv('app', 't1', 'FOO=bar\n');
    expect(await resolveTenantDbId('app', 't1', undefined)).toBe('app_t1');
  });

  it('falls back to the same DB id tenant create uses for hyphenated ids', async () => {
    await writeEnv('my-app', 't-1', 'FOO=bar\n');
    expect(await resolveTenantDbId('my-app', 't-1', undefined)).toBe('my_app_t_1');
  });

  it('falls back when the tenant .env is missing', async () => {
    expect(await resolveTenantDbId('app', 'nope', undefined)).toBe('app_nope');
  });

  it('strips the effective prefix from a migrated DB_NAME', async () => {
    await writeEnv('app', 't1', 'DB_NAME=acme_proj_t1\n');
    expect(await resolveTenantDbId('app', 't1', undefined)).toBe('proj_t1');
  });

  it('passes DB_NAME through when it lacks the prefix', async () => {
    await writeEnv('app', 't1', 'DB_NAME=proj_t1\n');
    expect(await resolveTenantDbId('app', 't1', undefined)).toBe('proj_t1');
  });

  it('passes DB_NAME through for an empty db_prefix', async () => {
    await writeEnv('app', 't1', 'DB_NAME=acme_proj_t1\n');
    expect(await resolveTenantDbId('app', 't1', { db_prefix: '' } as any)).toBe('acme_proj_t1');
  });
});
