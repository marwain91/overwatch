import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Fake docker: `inspect --format ... <container>` answers from `running`;
// every other docker call succeeds silently and is recorded.
const running: Record<string, string> = {};
const dockerCalls: string[][] = [];
vi.mock('child_process', async (orig) => {
  const actual = await orig<typeof import('child_process')>();
  const execFile = (cmd: string, args: string[], ...rest: any[]) => {
    const cb = rest[rest.length - 1];
    dockerCalls.push(args);
    if (args[0] === 'inspect' && args[1] === '--format') {
      const image = running[args[3]];
      if (image === undefined) return cb(new Error('No such object'));
      return cb(null, { stdout: `${image}\n`, stderr: '' });
    }
    return cb(null, { stdout: '', stderr: '' });
  };
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
