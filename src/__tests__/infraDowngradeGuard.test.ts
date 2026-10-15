import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Fake docker: `inspect --format ... <container>` answers from `running`;
// every other docker call succeeds silently and is recorded with its options.
// Callback shape and promisify behaviour match the real execFile.
const running: Record<string, string> = {};
const dockerCalls: string[][] = [];
const dockerOptions: Array<{ args: string[]; opts: any }> = [];
vi.mock('child_process', async (orig) => {
  const actual = await orig<typeof import('child_process')>();
  const { promisify } = await import('util');
  const execFile: any = (_cmd: string, args: string[], ...rest: any[]) => {
    const cb = rest[rest.length - 1];
    dockerCalls.push(args);
    dockerOptions.push({ args, opts: rest.length > 1 ? rest[0] : undefined });
    if (args[0] === 'inspect' && args[1] === '--format') {
      const image = running[args[3]];
      if (image === undefined) return cb(Object.assign(new Error('No such object'), { code: 1 }), '', 'Error: No such object');
      return cb(null, `${image}\n`, '');
    }
    return cb(null, '', '');
  };
  execFile[promisify.custom] = (cmd: string, args: string[], opts?: any) => new Promise((resolve, reject) => {
    execFile(cmd, args, opts ?? {}, (err: any, stdout: string, stderr: string) => (err ? reject(err) : resolve({ stdout, stderr })));
  });
  return { ...actual, execFile };
});

import { isDbDowngrade, parseImageVersion } from '../services/infraTemplates';

let tmpRoot: string;
let deployDir: string;

async function seedConfig(dbType: 'mariadb' | 'postgres' = 'mariadb'): Promise<void> {
  const configPath = path.join(deployDir, 'overwatch', 'overwatch.yaml');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `
project:
  name: "Acme"
  prefix: "acme"
  db_prefix: ""
database:
  type: "${dbType}"
  host: "acme-${dbType}"
  port: ${dbType === 'mariadb' ? 3306 : 5432}
  root_user: "root"
  root_password_env: "MYSQL_ROOT_PASSWORD"
  container_name: "acme-${dbType}"
networking:
  external_network: "acme-network"
  apps_path: "${path.join(deployDir, 'apps')}"
data_dir: "${path.join(deployDir, 'overwatch', 'data')}"
traefik:
  cert_resolvers:
    - name: letsencrypt
      challenge: http
      acme_email: ops@example.com
`);
  process.env.OVERWATCH_CONFIG = configPath;
  const loader = await import('../config/loader');
  loader.clearConfigCache();
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-guard-'));
  deployDir = path.join(tmpRoot, 'deploy');
  await fs.mkdir(deployDir, { recursive: true });
  for (const k of Object.keys(running)) delete running[k];
  dockerCalls.length = 0;
  dockerOptions.length = 0;
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
  delete process.env.OVERWATCH_CONFIG;
});

describe('image version helpers', () => {
  it('parses major.minor and treats a bare major as .0', () => {
    expect(parseImageVersion('mariadb:10.11')).toEqual([10, 11]);
    expect(parseImageVersion('mariadb:11')).toEqual([11, 0]);
    expect(parseImageVersion('postgres:16-alpine')).toEqual([16, 0]);
    expect(parseImageVersion('registry:5000/mariadb:11.4.2')).toEqual([11, 4]);
  });

  it('returns null for untagged, latest and digest-pinned images', () => {
    expect(parseImageVersion('mariadb')).toBeNull();
    expect(parseImageVersion('mariadb:latest')).toBeNull();
    expect(parseImageVersion('mariadb@sha256:abc')).toBeNull();
    expect(parseImageVersion('registry:5000/mariadb')).toBeNull();
  });

  it('detects only strictly lower versions', () => {
    expect(isDbDowngrade('mariadb:11', 'mariadb:10.11')).toBe(true);
    expect(isDbDowngrade('mariadb:10.11', 'mariadb:10.6')).toBe(true);
    expect(isDbDowngrade('mariadb:10.11', 'mariadb:10.11')).toBe(false);
    expect(isDbDowngrade('mariadb:10.11', 'mariadb:11')).toBe(false);
    expect(isDbDowngrade('mariadb:latest', 'mariadb:10.11')).toBe(false);
  });
});

describe('deployInfra downgrade guard', () => {
  it('refuses 11 -> 10.11 before writing files or running compose', async () => {
    await seedConfig();
    running['acme-mariadb'] = 'mariadb:11';
    const { deployInfra } = await import('../services/infraTemplates');

    await expect(deployInfra({ deployDir })).rejects.toMatchObject({ name: 'DbDowngradeError' });
    await expect(fs.access(path.join(deployDir, 'infrastructure'))).rejects.toThrow();
    expect(dockerCalls.some(a => a[0] === 'compose')).toBe(false);
  });

  it('allows the same version', async () => {
    await seedConfig();
    running['acme-mariadb'] = 'mariadb:10.11';
    const { deployInfra } = await import('../services/infraTemplates');
    const result = await deployInfra({ deployDir });
    expect(result.composeRestarted).toBe(true);
  });

  it('allows an upgrade (running 10.6 -> 10.11)', async () => {
    await seedConfig();
    running['acme-mariadb'] = 'mariadb:10.6';
    const { deployInfra } = await import('../services/infraTemplates');
    await expect(deployInfra({ deployDir })).resolves.toMatchObject({ composeRestarted: true });
  });

  it('proceeds when the container is absent', async () => {
    await seedConfig();
    const { deployInfra } = await import('../services/infraTemplates');
    await expect(deployInfra({ deployDir })).resolves.toMatchObject({ composeRestarted: true });
  });

  it('proceeds with an explicit allowDbDowngrade', async () => {
    await seedConfig();
    running['acme-mariadb'] = 'mariadb:11';
    const { deployInfra } = await import('../services/infraTemplates');
    await expect(deployInfra({ deployDir, allowDbDowngrade: true })).resolves.toMatchObject({ composeRestarted: true });
  });

  it('guards the postgres container too', async () => {
    await seedConfig('postgres');
    running['acme-postgres'] = 'postgres:17';
    const { deployInfra } = await import('../services/infraTemplates');
    await expect(deployInfra({ deployDir })).rejects.toThrow(/postgres:16/);
  });

  it('does not consult docker on a dry run', async () => {
    await seedConfig();
    running['acme-mariadb'] = 'mariadb:11';
    const { deployInfra } = await import('../services/infraTemplates');
    await expect(deployInfra({ deployDir, dryRun: true })).resolves.toMatchObject({ dryRun: true });
    expect(dockerCalls).toHaveLength(0);
  });
});

describe('deployInfra docker calls', () => {
  afterEach(() => { delete process.env.JWT_SECRET; });

  it('run with the allowlisted env and a timeout, like every other docker call', async () => {
    await seedConfig();
    process.env.JWT_SECRET = 'must-not-reach-docker';
    running['acme-mariadb'] = 'mariadb:10.11';
    const { deployInfra } = await import('../services/infraTemplates');
    await deployInfra({ deployDir });

    const kinds = dockerOptions.map(c => c.args.slice(0, 2).join(' '));
    expect(kinds).toEqual(expect.arrayContaining(['inspect --format', 'network inspect', 'compose --file']));
    for (const { args, opts } of dockerOptions) {
      expect(opts?.env, args.join(' ')).toBeDefined();
      expect(opts.env.JWT_SECRET, args.join(' ')).toBeUndefined();
      expect(opts.timeout, args.join(' ')).toBeGreaterThan(0);
    }
    // Compose resolves ${VAR} from infrastructure/.env, so it runs from that directory.
    const compose = dockerOptions.find(c => c.args[0] === 'compose')!;
    expect(compose.opts.cwd).toBe(path.join(deployDir, 'infrastructure'));
  });
});
