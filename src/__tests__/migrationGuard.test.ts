import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';

let tmpRoot: string;
let configPath: string;
let dataDir: string;

const LEGACY_YAML = {
  project: { name: 'Acme', prefix: 'acme', db_prefix: 'acme' },
  database: { type: 'mariadb', host: 'db', port: 3306, container_name: 'db', root_user_env: 'DB_ROOT_USER', root_password_env: 'DB_ROOT_PW' },
  registry: { type: 'ghcr', url: 'ghcr.io', repository: 'acme/app', auth: { type: 'token', username_env: 'GH_USER', token_env: 'GH_TOKEN' } },
  services: [{ name: 'web', image_suffix: '-web' }],
  data_dir: '',
};

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-migration-'));
  dataDir = path.join(tmpRoot, 'data');
  configPath = path.join(tmpRoot, 'overwatch.yaml');
  await fs.mkdir(dataDir, { recursive: true });

  const config = { ...LEGACY_YAML, data_dir: dataDir };
  await fs.writeFile(configPath, yaml.dump(config));

  process.env.OVERWATCH_CONFIG = configPath;
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.OVERWATCH_CONFIG;
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
});

describe('isLegacyFormat — populated apps.json guard', () => {
  it('returns false when apps.json already has entries, even with legacy yaml and no marker', async () => {
    // Populated multi-app apps.json — simulates a host where the marker file vanished
    // (volume swap, data_dir change) but migration clearly already happened.
    await fs.writeFile(
      path.join(dataDir, 'apps.json'),
      JSON.stringify([{ id: 'acme' }, { id: 'gadgets' }, { id: 'widgets' }])
    );
    expect(fsSync.existsSync(path.join(dataDir, '.migration-v2-complete'))).toBe(false);

    const { isLegacyFormat } = await import('../services/migration');
    expect(isLegacyFormat()).toBe(false);
  });

  it('returns true when apps.json is missing, legacy yaml, no marker', async () => {
    const { isLegacyFormat } = await import('../services/migration');
    expect(isLegacyFormat()).toBe(true);
  });

  it('empty apps.json array does not block legacy detection (no apps to clobber)', async () => {
    await fs.writeFile(path.join(dataDir, 'apps.json'), '[]');
    const { isLegacyFormat } = await import('../services/migration');
    expect(isLegacyFormat()).toBe(true);
  });
});

describe('runMigration — refuses to overwrite populated apps.json', () => {
  it('throws if apps.json already contains apps', async () => {
    await fs.writeFile(
      path.join(dataDir, 'apps.json'),
      JSON.stringify([{ id: 'acme' }, { id: 'gadgets' }, { id: 'widgets' }])
    );

    const { runMigration } = await import('../services/migration');
    await expect(runMigration()).rejects.toThrow(/Refusing to overwrite/);

    // apps.json must be untouched
    const after = JSON.parse(await fs.readFile(path.join(dataDir, 'apps.json'), 'utf-8'));
    expect(after).toHaveLength(3);
    expect(after.map((a: any) => a.id).sort()).toEqual(['acme', 'gadgets', 'widgets']);
  });
});
