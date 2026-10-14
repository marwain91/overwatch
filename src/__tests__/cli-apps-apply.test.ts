import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

let tmpRoot: string;
let dataDir: string;
let configPath: string;

const cliEntry = path.resolve(__dirname, '..', 'cli.ts');

function validStatic(id: string) {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    domain_template: `*.${id}.example`,
    registry: { type: 'ghcr', url: 'ghcr.io', repository: `ns/${id}`, auth: { type: 'token' } },
    services: [{ name: 'web', image_suffix: 'web', ports: { internal: 80 } }],
    default_image_tag: 'latest',
  };
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

function runCli(args: string[], stdin?: string) {
  const raw = spawnSync(process.execPath, ['--import', 'tsx', cliEntry, ...args], {
    input: stdin,
    encoding: 'utf-8',
    env: { ...process.env, OVERWATCH_CONFIG: configPath, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  return { ...raw, stdout: stripAnsi(raw.stdout ?? ''), stderr: stripAnsi(raw.stderr ?? '') };
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-cli-'));
  dataDir = path.join(tmpRoot, 'data');
  await fs.mkdir(path.join(dataDir, 'apps.d'), { recursive: true });
  configPath = path.join(tmpRoot, 'overwatch.yaml');
  await fs.writeFile(configPath, `
project:
  name: "Test"
  prefix: "test"
  db_prefix: "test"
database:
  type: "mariadb"
  host: "h"
  port: 3306
  root_user: "root"
  root_password_env: "MYSQL_ROOT_PASSWORD"
  container_name: "c"
networking:
  external_network: "test-network"
  apps_path: "${path.join(tmpRoot, 'apps')}"
data_dir: "${dataDir}"
`);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// The first tsx spawn compiles the whole CLI graph (tens of seconds on a loaded
// machine); warm tsx's on-disk cache once so no single test pays for it.
beforeAll(() => {
  spawnSync(process.execPath, ['--import', 'tsx', cliEntry, '--help'], { encoding: 'utf-8' });
}, 180_000);

// Each test still spawns a fresh CLI process (1-5s, more on a loaded machine).
describe('overwatch apps apply — end-to-end', { timeout: 30_000 }, () => {
  it('creates an app from a file', async () => {
    const appFile = path.join(tmpRoot, 'acme.json');
    await fs.writeFile(appFile, JSON.stringify(validStatic('acme')));

    const proc = runCli(['apps', 'apply', appFile]);
    expect(proc.status).toBe(0);
    expect(proc.stdout).toMatch(/acme created/);

    const onDisk = await fs.readFile(path.join(dataDir, 'apps.d', 'acme.json'), 'utf-8');
    expect(JSON.parse(onDisk).id).toBe('acme');
  });

  it('refuses raw labels that address objects outside the app', async () => {
    const def: any = validStatic('acme');
    def.services[0].routing = { raw_labels: { 'traefik.tcp.routers.x.rule': 'HostSNI(`*`)' } };
    const appFile = path.join(tmpRoot, 'acme.json');
    await fs.writeFile(appFile, JSON.stringify(def));
    const proc = runCli(['apps', 'apply', appFile]);
    expect(proc.status).toBe(2);
    expect(proc.stderr).toContain('traefik.tcp.routers.x.rule');
    await expect(fs.stat(path.join(dataDir, 'apps.d', 'acme.json'))).rejects.toThrow();
  });

  it('refuses masked credential placeholders copied from a non-admin read', async () => {
    const def: any = validStatic('acme');
    def.traefik = { middlewares: { gate: { type: 'basicAuth', users: ['alice:••••••••'] } } };
    const appFile = path.join(tmpRoot, 'acme.json');
    await fs.writeFile(appFile, JSON.stringify(def));
    const proc = runCli(['apps', 'apply', appFile]);
    expect(proc.status).toBe(2);
    expect(proc.stderr).toContain('traefik.middlewares.gate');
    await expect(fs.stat(path.join(dataDir, 'apps.d', 'acme.json'))).rejects.toThrow();
  });

  it('refuses a service name that is not a slug', async () => {
    const def: any = validStatic('acme');
    def.services[0].name = 'web"x';
    const appFile = path.join(tmpRoot, 'acme.json');
    await fs.writeFile(appFile, JSON.stringify(def));
    const proc = runCli(['apps', 'apply', appFile]);
    expect(proc.status).toBe(2);
    expect(proc.stderr).toMatch(/service name/i);
    await expect(fs.stat(path.join(dataDir, 'apps.d', 'acme.json'))).rejects.toThrow();
  });

  it('reads from stdin with "-"', async () => {
    const proc = runCli(['apps', 'apply', '-'], JSON.stringify(validStatic('widgets')));
    expect(proc.status).toBe(0);
    expect(proc.stdout).toMatch(/widgets created/);
  });

  it('is idempotent — second apply reports noop', async () => {
    const appFile = path.join(tmpRoot, 'acme.json');
    await fs.writeFile(appFile, JSON.stringify(validStatic('acme')));
    runCli(['apps', 'apply', appFile]);
    const proc = runCli(['apps', 'apply', appFile]);
    expect(proc.status).toBe(0);
    expect(proc.stdout).toMatch(/acme noop/);
  });

  it('writes an audit.log entry', async () => {
    const appFile = path.join(tmpRoot, 'acme.json');
    await fs.writeFile(appFile, JSON.stringify(validStatic('acme')));
    runCli(['apps', 'apply', appFile]);

    const audit = await fs.readFile(path.join(dataDir, 'audit.log'), 'utf-8');
    const lines = audit.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.action).toMatch(/apps\.apply acme/);
    expect(last.user).toMatch(/^cli:/);
  });

  it('exits 2 on invalid JSON', async () => {
    const appFile = path.join(tmpRoot, 'broken.json');
    await fs.writeFile(appFile, '{not valid');
    const proc = runCli(['apps', 'apply', appFile]);
    expect(proc.status).toBe(2);
    expect(proc.stderr).toMatch(/Invalid JSON/);
  });

  it('exits 2 when the app is in the trash', async () => {
    await fs.writeFile(path.join(dataDir, 'apps.trashed.json'), JSON.stringify([{
      app: { ...validStatic('acme'), createdAt: 'x', updatedAt: 'x' },
      deletedAt: 'x', deletedBy: 'x', tenantCount: 0,
    }]));
    const appFile = path.join(tmpRoot, 'acme.json');
    await fs.writeFile(appFile, JSON.stringify(validStatic('acme')));
    const proc = runCli(['apps', 'apply', appFile]);
    expect(proc.status).toBe(2);
    expect(proc.stderr).toMatch(/in trash/);
  });
});
