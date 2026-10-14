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
