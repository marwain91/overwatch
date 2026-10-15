import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

vi.mock('child_process', async (orig) => {
  const actual = await orig<typeof import('child_process')>();
  const execFile = (_cmd: string, _args: string[], ...rest: any[]) => {
    rest[rest.length - 1](null, { stdout: '', stderr: '' });
  };
  return { ...actual, execFile };
});

import type { InitConfig } from '../cli/init';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let tmpRoot: string;
let deployDir: string;

function answers(deployDir: string, over: Partial<InitConfig> = {}): InitConfig {
  return {
    projectName: 'Acme',
    projectPrefix: 'acme',
    deployDir,
    domain: 'example.com',
    dbType: 'mariadb',
    dbPassword: 'secret-db',
    dnsProvider: 'cloudflare',
    dnsEnvVars: [{ name: 'CF_DNS_API_TOKEN', value: 'tok' }],
    adminEmail: 'ops@example.com',
    overwatchDomain: 'overwatch.example.com',
    googleClientId: 'x.apps.googleusercontent.com',
    allowedAdminEmails: 'a@example.com',
    jwtSecret: 'jwt',
    ...over,
  };
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-init-'));
  deployDir = path.join(tmpRoot, 'deploy');
  await fs.mkdir(path.join(deployDir, 'overwatch'), { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
  delete process.env.OVERWATCH_CONFIG;
});

async function deployFromInitYaml(c: InitConfig): Promise<void> {
  const deployDir = c.deployDir;
  const { generateOverwatchYaml } = await import('../cli/init');
  const configPath = path.join(deployDir, 'overwatch', 'overwatch.yaml');
  await fs.writeFile(configPath, generateOverwatchYaml(c));
  // Scope the env var to this call so cases never observe each other's config.
  const previous = process.env.OVERWATCH_CONFIG;
  process.env.OVERWATCH_CONFIG = configPath;
  try {
    (await import('../config/loader')).clearConfigCache();
    const { deployInfra } = await import('../services/infraTemplates');
    await deployInfra({ deployDir });
  } finally {
    if (previous === undefined) delete process.env.OVERWATCH_CONFIG;
    else process.env.OVERWATCH_CONFIG = previous;
    (await import('../config/loader')).clearConfigCache();
  }
}

describe.each(['mariadb', 'postgres'] as const)('init vs infra deploy (%s)', (dbType) => {
  it('files written by init (generateFiles) are byte-identical to what `infra deploy` writes', async () => {
    // Each case gets its own deploy dirs: a slow case must never see the next case's.
    const initDir = path.join(tmpRoot, 'via-init');
    const deployDirForInfra = path.join(tmpRoot, 'via-infra-deploy');
    await fs.mkdir(path.join(deployDirForInfra, 'overwatch'), { recursive: true });
    const { renderInitInfraFiles, generateFiles } = await import('../cli/init');
    const rendered = renderInitInfraFiles(answers(initDir, { dbType }));
    expect(rendered.length).toBeGreaterThan(0);

    vi.spyOn(console, 'log').mockImplementation(() => {});
    await generateFiles(answers(initDir, { dbType }));
    await deployFromInitYaml(answers(deployDirForInfra, { dbType }));

    for (const f of rendered) {
      const written = await fs.readFile(path.join(initDir, f.dest), 'utf-8');
      expect(written, `init wrote ${f.dest}`).toBe(f.content);
      // `infra deploy` renders the same bytes (paths differ only in APPS_PATH_ON_HOST).
      const deployed = await fs.readFile(path.join(deployDirForInfra, f.dest), 'utf-8');
      expect(deployed.split(deployDirForInfra).join(initDir), `infra deploy ${f.dest}`).toBe(f.content);
    }
  });

  it(`${dbType === 'postgres' ? 'does not create' : 'creates'} the mariadb init placeholder`, async () => {
    const dir = path.join(tmpRoot, 'gitkeep');
    const { generateFiles } = await import('../cli/init');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await generateFiles(answers(dir, { dbType }));
    const exists = await fs.access(path.join(dir, 'infrastructure/mariadb/init/.gitkeep')).then(() => true, () => false);
    expect(exists).toBe(dbType === 'mariadb');
  });
});

describe('init output content', () => {
  it('uses the reference versions, the shared letsencrypt volume and a read-write overwatch.yaml mount', async () => {
    const { renderInitInfraFiles } = await import('../cli/init');
    const files = Object.fromEntries(renderInitInfraFiles(answers(deployDir)).map(f => [f.dest, f.content]));
    const infra = files['infrastructure/docker-compose.yml'];
    expect(infra).toContain('image: mariadb:10.11');
    expect(infra).toContain('image: traefik:v3.6');
    expect(infra).toContain('traefik-letsencrypt:/letsencrypt');
    expect(infra).toContain('CF_DNS_API_TOKEN=${CF_DNS_API_TOKEN}');
    const ow = files['overwatch/docker-compose.yml'];
    expect(ow).toContain('./overwatch.yaml:/app/overwatch.yaml\n');
    expect(ow).not.toMatch(/overwatch\.yaml:\/app\/overwatch\.yaml:ro/);
    expect(ow).toContain('Host(`overwatch.example.com`)');
    expect(ow).toContain('ALLOWED_ADMIN_EMAILS');
  });

  it('writes a postgres stack for dbType=postgres', async () => {
    const { renderInitInfraFiles } = await import('../cli/init');
    const files = Object.fromEntries(renderInitInfraFiles(answers(deployDir, { dbType: 'postgres' })).map(f => [f.dest, f.content]));
    expect(files['infrastructure/docker-compose.yml']).toContain('image: postgres:16');
    expect(files['overwatch/docker-compose.yml']).toContain('POSTGRES_PASSWORD');
  });
});

describe('init and the admin-users seed', () => {
  afterEach(() => {
    delete process.env.ALLOWED_ADMIN_EMAILS;
    vi.doUnmock('../config');
  });

  it('leaves admin-users.json to the store, so ALLOWED_ADMIN_EMAILS seeds the first login', async () => {
    const { generateFiles } = await import('../cli/init');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await generateFiles(answers(deployDir));
    const dataDir = path.join(deployDir, 'overwatch', 'data');
    await expect(fs.access(path.join(dataDir, 'admin-users.json'))).rejects.toThrow();

    // First server start: the store creates the file from the seed.
    process.env.ALLOWED_ADMIN_EMAILS = 'a@example.com';
    vi.doMock('../config', () => ({ getDataDir: () => dataDir }));
    vi.resetModules();
    const { isAdminEmail } = await import('../services/users');
    expect(await isAdminEmail('a@example.com')).toBe(true);
  });
});
