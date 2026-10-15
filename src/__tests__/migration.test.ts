import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let tmpRoot: string;
let configPath: string;
let dataDir: string;

const LEGACY_YAML = {
  project: { name: 'Acme', prefix: 'acme', db_prefix: 'acme' },
  database: { type: 'mariadb', host: 'db', port: 3306, container_name: 'db', root_user_env: 'DB_ROOT_USER', root_password_env: 'DB_ROOT_PW' },
  registry: { type: 'ghcr', url: 'ghcr.io', repository: 'acme/app', auth: { type: 'token', username_env: 'GH_USER', token_env: 'GH_TOKEN' } },
  services: [{ name: 'web', image_suffix: '-web' }],
  networking: { external_network: 'acme-net', tenants_path: '', apps_path: '' },
};

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-migration-run-'));
  dataDir = path.join(tmpRoot, 'data');
  configPath = path.join(tmpRoot, 'overwatch.yaml');
  await fs.mkdir(dataDir, { recursive: true });
  LEGACY_YAML.networking = { external_network: 'acme-net', tenants_path: path.join(tmpRoot, 'tenants'), apps_path: path.join(tmpRoot, 'apps') };
  await fs.mkdir(LEGACY_YAML.networking.tenants_path, { recursive: true });
  await fs.writeFile(configPath, yaml.dump({ ...LEGACY_YAML, data_dir: dataDir }));
  process.env.OVERWATCH_CONFIG = configPath;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  delete process.env.OVERWATCH_CONFIG;
  vi.restoreAllMocks();
  vi.resetModules();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('runMigration -> config writer', () => {
  it('slims overwatch.yaml through the writer: same inode, valid slim config, backup, marker, no scratch files', async () => {
    const ino = fsSync.statSync(configPath).ino;
    const { runMigration } = await import('../services/migration');
    await runMigration();

    expect(fsSync.statSync(configPath).ino).toBe(ino);
    const slim = yaml.load(fsSync.readFileSync(configPath, 'utf-8')) as any;
    expect(slim.registry).toBeUndefined();
    expect(slim.services).toBeUndefined();
    expect(slim.project.prefix).toBe('acme');
    expect(fsSync.existsSync(configPath + '.pre-migration')).toBe(true);
    expect(fsSync.existsSync(path.join(dataDir, '.migration-v2-complete'))).toBe(true);
    expect(fsSync.readdirSync(path.join(dataDir, '.config-tmp'))).toEqual([]);
  });

  it('a failing config write (e.g. unwritable data dir) degrades to a warning and still writes the marker', async () => {
    vi.doMock('../config/writer', () => ({ writeOverwatchConfig: async () => { throw Object.assign(new Error('read-only'), { code: 'EROFS' }); } }));
    const { runMigration } = await import('../services/migration');
    await runMigration();
    vi.doUnmock('../config/writer');
    expect(fsSync.existsSync(path.join(dataDir, '.migration-v2-complete'))).toBe(true);
    expect((yaml.load(fsSync.readFileSync(configPath, 'utf-8')) as any).services).toBeDefined();
  });
});

describe('runMigration — marker only on success, quoting-aware .env edits', () => {
  const tenantsDir = () => path.join(tmpRoot, 'tenants');
  const migratedEnv = (t: string) => path.join(tmpRoot, 'apps', 'acme', 'tenants', t, '.env');
  const marker = () => path.join(dataDir, '.migration-v2-complete');

  async function legacyTenant(id: string, env: string) {
    await fs.mkdir(path.join(tenantsDir(), id), { recursive: true });
    await fs.writeFile(path.join(tenantsDir(), id, '.env'), env, { mode: 0o600 });
  }

  afterEach(() => {
    vi.doUnmock('fs/promises');
    vi.doUnmock('../utils/security');
  });

  it('does not write the marker when a tenant cannot be moved, and a re-run completes', async () => {
    await legacyTenant('t1', 'TENANT_DOMAIN=t1.example.com\n');
    let failCopy = true;
    vi.doMock('fs/promises', async () => {
      const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
      return {
        ...actual,
        cp: async (...a: Parameters<typeof actual.cp>) => {
          if (failCopy) throw Object.assign(new Error('EIO: i/o error, copy'), { code: 'EIO' });
          return actual.cp(...a);
        },
      };
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runMigration, isLegacyFormat } = await import('../services/migration');

    await expect(runMigration()).rejects.toThrow(/t1.*EIO|EIO.*t1/);
    expect(fsSync.existsSync(marker())).toBe(false);
    // Nothing that blocks a retry: the install still reads as legacy.
    expect(isLegacyFormat()).toBe(true);

    failCopy = false;
    await runMigration();
    expect(fsSync.existsSync(marker())).toBe(true);
    expect(fsSync.readFileSync(migratedEnv('t1'), 'utf-8')).toMatch(/^APP_ID=acme$/m);
  });

  it('fails instead of skipping a tenant whose .env cannot be written', async () => {
    await legacyTenant('t1', 'TENANT_DOMAIN=t1.example.com\n');
    vi.doMock('../utils/security', async () => {
      const actual = await vi.importActual<any>('../utils/security');
      return { ...actual, writeSecretFile: async () => { throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }); } };
    });
    const { runMigration } = await import('../services/migration');
    await expect(runMigration()).rejects.toThrow(/ENOSPC/);
    expect(fsSync.existsSync(marker())).toBe(false);
  });

  it('reads a quoted TENANT_DOMAIN and adds APP_ID even when another key ends in APP_ID', async () => {
    await legacyTenant('t1', "SOME_APP_ID=other\nTENANT_DOMAIN='shop.example.com'\n");
    // A routed service, so the regenerated compose carries the tenant's Host rule.
    await fs.writeFile(configPath, yaml.dump({
      ...LEGACY_YAML, data_dir: dataDir, services: [{ name: 'web', image_suffix: '-web', ports: { internal: 80 } }],
    }));
    const { runMigration } = await import('../services/migration');
    await runMigration();

    const apps = JSON.parse(fsSync.readFileSync(path.join(dataDir, 'apps.json'), 'utf-8'));
    expect(apps[0].domain_template).toBe('*.example.com');
    const env = fsSync.readFileSync(migratedEnv('t1'), 'utf-8');
    expect(env).toMatch(/^APP_ID=acme$/m);
    expect(env).toMatch(/^COMPOSE_PROJECT_NAME=acme-t1$/m);
    expect(env).toMatch(/^SOME_APP_ID=other$/m);
    const compose = fsSync.readFileSync(path.join(tmpRoot, 'apps', 'acme', 'tenants', 't1', 'docker-compose.yml'), 'utf-8');
    expect(compose).toContain('shop.example.com');
    expect(compose).not.toContain("'shop.example.com");
  });
});
