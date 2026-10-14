import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let appsDir: string;

async function load() {
  vi.doMock('../config', () => ({ getAppsDir: () => appsDir, getDataDir: () => appsDir }));
  const store = await import('../services/tenantStore');
  const envVars = await import('../services/envVars');
  return { ...store, formatEnvLine: envVars.formatEnvLine };
}

async function mkTenant(appId: string, tenantId: string, env?: string) {
  const dir = path.join(appsDir, appId, 'tenants', tenantId);
  await fs.mkdir(dir, { recursive: true });
  if (env !== undefined) await fs.writeFile(path.join(dir, '.env'), env);
  return dir;
}

beforeEach(async () => {
  appsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-tenantstore-'));
});

afterEach(async () => {
  await fs.rm(appsDir, { recursive: true, force: true });
  vi.resetModules();
  vi.doUnmock('../config');
});

describe('tenantDir', () => {
  it('joins apps/<app>/tenants/<tenant>', async () => {
    const { tenantDir } = await load();
    expect(tenantDir('acme', 'widgets')).toBe(path.join(appsDir, 'acme', 'tenants', 'widgets'));
  });

  it.each([
    ['..', 'x'], ['x', '..'], ['a/../..', 'x'], ['x', '../../etc'], ['x', '/etc/passwd'], ['/abs', 'x'], ['', 'x'], ['x', ''], ['x', '.'], ['x', 'a/b'],
  ])('rejects %j / %j', async (appId, tenantId) => {
    const { tenantDir } = await load();
    expect(() => tenantDir(appId, tenantId)).toThrow(/Invalid (app|tenant) id/);
  });

  it('assertTenantDir rejects a tenant dir that is a symlink out of the apps dir', async () => {
    const { assertTenantDir } = await load();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-outside-'));
    try {
      await fs.mkdir(path.join(appsDir, 'acme', 'tenants'), { recursive: true });
      await fs.symlink(outside, path.join(appsDir, 'acme', 'tenants', 'evil'));
      await expect(assertTenantDir('acme', 'evil')).rejects.toThrow(/outside/);
      await mkTenant('acme', 'good');
      await expect(assertTenantDir('acme', 'good')).resolves.toBe(path.join(appsDir, 'acme', 'tenants', 'good'));
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe('listTenantDirs', () => {
  it('lists directories only, skipping dot entries and files, across apps', async () => {
    const { listTenantDirs } = await load();
    await mkTenant('a', 't1');
    await mkTenant('a', 't2');
    await mkTenant('a', '.hidden');
    await fs.writeFile(path.join(appsDir, 'a', 'tenants', 'file.txt'), 'x');
    await mkTenant('b', 't3');
    await fs.mkdir(path.join(appsDir, 'c'), { recursive: true }); // app without tenants dir
    await fs.writeFile(path.join(appsDir, 'stray.txt'), 'x');
    const all = await listTenantDirs();
    expect(all.map(t => `${t.appId}/${t.tenantId}`).sort()).toEqual(['a/t1', 'a/t2', 'b/t3']);
    expect(all.find(t => t.tenantId === 't3')!.dir).toBe(path.join(appsDir, 'b', 'tenants', 't3'));
  });

  it('scopes to one app and tolerates a missing tenants dir or apps dir', async () => {
    const { listTenantDirs } = await load();
    await mkTenant('a', 't1');
    await mkTenant('b', 't2');
    expect((await listTenantDirs('a')).map(t => t.tenantId)).toEqual(['t1']);
    expect(await listTenantDirs('nope')).toEqual([]);
    await fs.rm(appsDir, { recursive: true, force: true });
    expect(await listTenantDirs()).toEqual([]);
  });

  it('hands per-app listing failures to onError instead of throwing', async () => {
    await mkTenant('a', 't1');
    await mkTenant('b', 't2');
    vi.doMock('fs/promises', async () => {
      const real = await vi.importActual<typeof import('fs/promises')>('fs/promises');
      const readdir = (async (p: any, ...rest: any[]) => {
        if (String(p).endsWith(path.join('a', 'tenants'))) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return (real.readdir as any)(p, ...rest);
      }) as typeof real.readdir;
      return { ...real, readdir, default: { ...real, readdir } };
    });
    const { listTenantDirs } = await load();
    await expect(listTenantDirs('a')).rejects.toMatchObject({ code: 'EACCES' });
    const seen: string[] = [];
    const all = await listTenantDirs(undefined, { onError: (appId) => { seen.push(appId); } });
    expect(seen).toEqual(['a']);
    expect(all.map(t => t.tenantId)).toEqual(['t2']);
    vi.doUnmock('fs/promises');
  });
});

describe('readTenantEnv', () => {
  const TRICKY = [
    'plain', '', 'pa$$word', '$', '$$', '${HOME}', "it's", "it's $5", 'say "hi" $x', 'back\\slash', 'back\\slash $x',
    'a=b=c', 'a=b $c', 'has # hash', 'has #hash $x', 'two words', ' lead $x', 'tail $x ', '"$"', "'$'", '\\$', '\\"$',
    'p@ss/w0rd?&=+', 'unicodé $ü',
  ];

  it.each(TRICKY.map(v => [JSON.stringify(v), v]))('round-trips formatEnvLine value %s', async (_label, value) => {
    const { readTenantEnv, formatEnvLine } = await load();
    await mkTenant('a', 't', `${formatEnvLine('KEY', value)}\nOTHER=1\n`);
    const env = await readTenantEnv('a', 't');
    // Surrounding whitespace is trimmed by the line parser, as before.
    expect(env.KEY).toBe(value.trim() === value || value.includes('$') ? value : value.trim());
    expect(env.OTHER).toBe('1');
  });

  it('parses comments, blanks and CRLF, and leaves hand-written unquoted values alone', async () => {
    const { readTenantEnv } = await load();
    await mkTenant('a', 't', '# c\r\n\r\nTENANT_DOMAIN=x.example.com\r\nIMAGE_TAG=v1\r\n');
    expect(await readTenantEnv('a', 't')).toEqual({ TENANT_DOMAIN: 'x.example.com', IMAGE_TAG: 'v1' });
  });

  it('unquotes hand-written quoted values the way compose reads them', async () => {
    const { readTenantEnv } = await load();
    await mkTenant('a', 't', 'A="x.example.com"\nB=\'y\'\n');
    expect(await readTenantEnv('a', 't')).toEqual({ A: 'x.example.com', B: 'y' });
  });

  it('rejects with ENOENT when the tenant has no .env', async () => {
    const { readTenantEnv } = await load();
    await mkTenant('a', 't');
    await expect(readTenantEnv('a', 't')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
