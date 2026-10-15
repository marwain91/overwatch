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

describe('runAppsV3Migration — safe to re-run, fails closed', () => {
  function app(id: string, extra: Record<string, unknown> = {}) {
    return {
      id,
      name: id.toUpperCase(),
      domain_template: `*.${id}.example`,
      registry: { type: 'ghcr', url: 'ghcr.io', repository: `ns/${id}`, auth: { type: 'token' } },
      services: [{ name: 'web' }],
      default_image_tag: 'latest',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
      ...extra,
    };
  }
  const staticOf = (a: Record<string, unknown>) => {
    const { createdAt: _c, updatedAt: _u, ...rest } = a;
    return rest;
  };
  const appsD = () => path.join(dataDir, 'apps.d');
  const appsJson = () => path.join(dataDir, 'apps.json');
  const listAppsD = () => (fsSync.existsSync(appsD()) ? fsSync.readdirSync(appsD()).filter(f => f.endsWith('.json')).sort() : []);

  async function load() {
    vi.doMock('../config', () => ({ getDataDir: () => dataDir }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    return import('../services/migration');
  }

  afterEach(() => {
    vi.doUnmock('../config');
    vi.restoreAllMocks();
  });

  it('checks every entry before writing; once apps.json is fixed, a re-run migrates all apps', async () => {
    await fs.writeFile(appsJson(), JSON.stringify([app('alpha'), { name: 'no id' }, app('gamma')]));
    const { runAppsV3Migration } = await load();
    await expect(runAppsV3Migration()).rejects.toThrow(/entry/i);
    expect(listAppsD()).toEqual([]);
    expect(fsSync.existsSync(appsJson())).toBe(true);

    await fs.writeFile(appsJson(), JSON.stringify([app('alpha'), app('beta'), app('gamma')]));
    await runAppsV3Migration();
    expect(listAppsD()).toEqual(['alpha.json', 'beta.json', 'gamma.json']);
    expect(fsSync.existsSync(appsJson())).toBe(false);
    expect(fsSync.existsSync(path.join(dataDir, 'apps.json.pre-apps.d'))).toBe(true);
    const runtime = JSON.parse(fsSync.readFileSync(path.join(dataDir, 'apps.runtime.json'), 'utf-8'));
    expect(runtime.beta).toEqual({ createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' });
  });

  it('refuses entries that would not load (schema) and duplicate ids, writing nothing', async () => {
    const { runAppsV3Migration } = await load();
    await fs.writeFile(appsJson(), JSON.stringify([app('alpha'), app('alpha', { name: 'Second' })]));
    await expect(runAppsV3Migration()).rejects.toThrow(/duplicate/i);
    await fs.writeFile(appsJson(), JSON.stringify([app('alpha'), app('beta', { services: [] })]));
    await expect(runAppsV3Migration()).rejects.toThrow(/beta/);
    expect(listAppsD()).toEqual([]);
    expect(fsSync.existsSync(appsJson())).toBe(true);
  });

  it('never writes outside apps.d for an id that is a path', async () => {
    await fs.writeFile(appsJson(), JSON.stringify([app('../escape')]));
    const { runAppsV3Migration } = await load();
    await expect(runAppsV3Migration()).rejects.toThrow(/escape/);
    expect(fsSync.existsSync(path.join(dataDir, 'escape.json'))).toBe(false);
  });

  it('finishes a run that stopped part-way when the files it wrote are unchanged', async () => {
    const apps = [app('alpha'), app('beta'), app('gamma')];
    await fs.writeFile(appsJson(), JSON.stringify(apps));
    await fs.mkdir(appsD(), { recursive: true });
    await fs.writeFile(path.join(appsD(), 'alpha.json'), JSON.stringify(staticOf(apps[0]), null, 2));
    const { runAppsV3Migration } = await load();
    await runAppsV3Migration();
    expect(listAppsD()).toEqual(['alpha.json', 'beta.json', 'gamma.json']);
    expect(fsSync.existsSync(appsJson())).toBe(false);
  });

  it('fails closed when apps.d already holds files that differ from apps.json', async () => {
    const apps = [app('alpha'), app('beta')];
    await fs.writeFile(appsJson(), JSON.stringify(apps));
    await fs.mkdir(appsD(), { recursive: true });
    const edited = JSON.stringify({ ...staticOf(apps[0]), name: 'Edited since' });
    await fs.writeFile(path.join(appsD(), 'alpha.json'), edited);
    const { runAppsV3Migration } = await load();
    await expect(runAppsV3Migration()).rejects.toThrow(/apps\.d\/alpha\.json/);
    expect(listAppsD()).toEqual(['alpha.json']);
    expect(fsSync.readFileSync(path.join(appsD(), 'alpha.json'), 'utf-8')).toBe(edited);
    expect(fsSync.existsSync(appsJson())).toBe(true);
  });

  it('fails closed when apps.d holds an app that apps.json does not list', async () => {
    await fs.writeFile(appsJson(), JSON.stringify([app('alpha')]));
    await fs.mkdir(appsD(), { recursive: true });
    await fs.writeFile(path.join(appsD(), 'zeta.json'), JSON.stringify(staticOf(app('zeta'))));
    const { runAppsV3Migration } = await load();
    await expect(runAppsV3Migration()).rejects.toThrow(/zeta/);
    expect(listAppsD()).toEqual(['zeta.json']);
  });

  it('keeps an existing apps.json.pre-apps.d backup', async () => {
    await fs.writeFile(path.join(dataDir, 'apps.json.pre-apps.d'), 'older backup');
    await fs.writeFile(appsJson(), JSON.stringify([app('alpha')]));
    const { runAppsV3Migration } = await load();
    await runAppsV3Migration();
    expect(fsSync.readFileSync(path.join(dataDir, 'apps.json.pre-apps.d'), 'utf-8')).toBe('older backup');
    const backups = fsSync.readdirSync(dataDir).filter(f => f.startsWith('apps.json.pre-apps.d'));
    expect(backups).toHaveLength(2);
  });

  it('is a no-op once apps.json is gone', async () => {
    await fs.mkdir(appsD(), { recursive: true });
    await fs.writeFile(path.join(appsD(), 'alpha.json'), JSON.stringify(staticOf(app('alpha'))));
    await fs.writeFile(path.join(dataDir, 'apps.json.pre-apps.d'), '[]');
    const { runAppsV3Migration } = await load();
    await runAppsV3Migration();
    expect(listAppsD()).toEqual(['alpha.json']);
  });
});

describe('pending schema migrations — one runner for the CLI and the server', () => {
  const versionsFile = () => path.join(dataDir, '.schema-versions.json');
  const app = (id: string) => ({
    id, name: id, domain_template: `*.${id}.example`,
    registry: { type: 'ghcr', url: 'ghcr.io', repository: `ns/${id}`, auth: { type: 'token' } },
    services: [{ name: 'web' }], default_image_tag: 'latest',
  });

  beforeEach(async () => {
    // Not a legacy install: no overwatch.yaml at this path.
    process.env.OVERWATCH_CONFIG = path.join(tmpRoot, 'missing.yaml');
    vi.doMock('../config', () => ({ getDataDir: () => dataDir }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await fs.writeFile(versionsFile(), JSON.stringify({ apps: 2, envVars: 2, tenantOverrides: 2, adminUsers: 1 }));
  });

  afterEach(() => {
    vi.doUnmock('../config');
    vi.restoreAllMocks();
  });

  it('runPendingMigrations runs the apps v3 split and then records the current versions', async () => {
    await fs.writeFile(path.join(dataDir, 'apps.json'), JSON.stringify([app('alpha')]));
    const { runPendingMigrations } = await import('../services/migration');
    const { CURRENT_SCHEMA_VERSIONS } = await import('../services/schemaVersions');
    await runPendingMigrations(() => {});
    expect(fsSync.readdirSync(path.join(dataDir, 'apps.d'))).toEqual(['alpha.json']);
    expect(JSON.parse(fsSync.readFileSync(versionsFile(), 'utf-8'))).toEqual(CURRENT_SCHEMA_VERSIONS);
  });

  it('with no versions file yet, splits a leftover apps.json before recording apps v3', async () => {
    await fs.rm(versionsFile());
    await fs.writeFile(path.join(dataDir, 'apps.json'), JSON.stringify([app('alpha')]));
    const { runPendingMigrations } = await import('../services/migration');
    const result = await runPendingMigrations(() => {});
    expect(result.initialised).toBe(true);
    expect(fsSync.readdirSync(path.join(dataDir, 'apps.d'))).toEqual(['alpha.json']);
    expect(fsSync.existsSync(path.join(dataDir, 'apps.json'))).toBe(false);
    expect(JSON.parse(fsSync.readFileSync(versionsFile(), 'utf-8')).apps).toBe(3);
  });

  it('`migrate up` leaves the apps version alone when the v3 migration fails', async () => {
    await fs.writeFile(path.join(dataDir, 'apps.json'), JSON.stringify([app('alpha'), app('beta')]));
    await fs.mkdir(path.join(dataDir, 'apps.d'));
    await fs.writeFile(path.join(dataDir, 'apps.d', 'alpha.json'), JSON.stringify({ ...app('alpha'), name: 'Edited' }));
    const { runMigrate } = await import('../cli/migrate');
    await expect(runMigrate(['up'])).rejects.toThrow(/alpha/);
    expect(JSON.parse(fsSync.readFileSync(versionsFile(), 'utf-8')).apps).toBe(2);
  });

  it('the server\'s OVERWATCH_AUTO_MIGRATE path calls the same runner', async () => {
    const src = await fs.readFile(path.join(__dirname, '..', 'index.ts'), 'utf-8');
    const step = src.slice(src.indexOf("runStartupStep('schema versions'"));
    const body = step.slice(0, step.indexOf('}, { critical: true });'));
    expect(body).toContain("OVERWATCH_AUTO_MIGRATE");
    expect(body).toMatch(/await runPendingMigrations\(/);
    expect(body).not.toContain('migrations will run as needed');
  });
});
