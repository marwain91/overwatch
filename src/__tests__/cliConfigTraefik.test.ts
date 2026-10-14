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
let answers: Record<string, string>;

const BASE = {
  project: { name: 'Acme', prefix: 'acme', db_prefix: 'acme' },
  database: { type: 'mariadb', host: 'db', port: 3306, container_name: 'db', root_user_env: 'DB_ROOT_USER', root_password_env: 'DB_ROOT_PW' },
};

vi.mock('inquirer', () => ({
  default: { prompt: async (qs: any[]) => ({ [qs[0].name]: answers[qs[0].name] ?? qs[0].default }), Separator: class {} },
}));

async function writeConfig(extra: Record<string, unknown>) {
  await fs.writeFile(configPath, yaml.dump({ ...BASE, data_dir: dataDir, ...extra }));
}
const readConfig = () => yaml.load(fsSync.readFileSync(configPath, 'utf-8')) as any;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-cli-traefik-'));
  dataDir = path.join(tmpRoot, 'data');
  configPath = path.join(tmpRoot, 'overwatch.yaml');
  await fs.mkdir(dataDir, { recursive: true });
  process.env.OVERWATCH_CONFIG = configPath;
  answers = {};
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  delete process.env.OVERWATCH_CONFIG;
  const { clearConfigCache } = await import('../config/loader');
  clearConfigCache();
  vi.restoreAllMocks();
  vi.resetModules();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const RESOLVER = { name: 'le', challenge: 'http', acme_email: 'a@b.co', entrypoint: 'web' };

describe('CLI traefik wiring onto the config writer', () => {
  it('resolver remove persists through the writer, keeping the inode and leaving no scratch files', async () => {
    await writeConfig({ traefik: { cert_resolvers: [RESOLVER, { ...RESOLVER, name: 'other' }] } });
    const ino = fsSync.statSync(configPath).ino;
    const { runConfigTraefik } = await import('../cli/config/traefik');
    await runConfigTraefik(['resolver', 'remove', 'le']);
    expect(readConfig().traefik.cert_resolvers.map((r: any) => r.name)).toEqual(['other']);
    expect(fsSync.statSync(configPath).ino).toBe(ino);
    expect(fsSync.readdirSync(path.join(dataDir, '.config-tmp'))).toEqual([]);
  });

  it('resolver remove of an unknown name does not rewrite the file', async () => {
    const text = `# hand written\n${yaml.dump({ ...BASE, data_dir: dataDir, traefik: { cert_resolvers: [RESOLVER] } })}`;
    await fs.writeFile(configPath, text);
    const { runConfigTraefik } = await import('../cli/config/traefik');
    await runConfigTraefik(['resolver', 'remove', 'ghost']);
    expect(fsSync.readFileSync(configPath, 'utf-8')).toBe(text);
  });

  it('migrate rewrites legacy networking.cert_resolvers into traefik.cert_resolvers', async () => {
    await writeConfig({ networking: { external_network: 'acme-net', cert_resolvers: { wildcard: 'wild', default: 'plain' } } });
    answers = { provider: 'cloudflare', acmeEmail: 'ops@acme.co', wildcardPattern: '*.app.acme.co', envVarKey: 'CF_DNS_API_TOKEN' };
    const { runConfigTraefik } = await import('../cli/config/traefik');
    await runConfigTraefik(['migrate']);
    const raw = readConfig();
    expect(raw.traefik.cert_resolvers.map((r: any) => r.name)).toEqual(['wild', 'plain']);
    expect(raw.networking?.cert_resolvers).toBeUndefined();
  });
});

describe('services/traefikConfig no-op deletes', () => {
  it('deleteCertResolver / deleteGlobalMiddleware on an absent key leave the file byte-identical', async () => {
    const text = `# hand written\n${yaml.dump({ ...BASE, data_dir: dataDir, traefik: { cert_resolvers: [RESOLVER], middlewares: {} } })}`;
    await fs.writeFile(configPath, text);
    const { deleteCertResolver, deleteGlobalMiddleware } = await import('../services/traefikConfig');
    await deleteCertResolver('ghost');
    await deleteGlobalMiddleware('ghost');
    expect(fsSync.readFileSync(configPath, 'utf-8')).toBe(text);
  });
});
