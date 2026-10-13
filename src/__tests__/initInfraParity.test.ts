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

let tmpRoot: string;
let deployDir: string;

function answers(over: Partial<InitConfig> = {}): InitConfig {
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
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
  delete process.env.OVERWATCH_CONFIG;
});

async function deployFromInitYaml(c: InitConfig): Promise<void> {
  const { generateOverwatchYaml } = await import('../cli/init');
  const configPath = path.join(deployDir, 'overwatch', 'overwatch.yaml');
  await fs.writeFile(configPath, generateOverwatchYaml(c));
  process.env.OVERWATCH_CONFIG = configPath;
  (await import('../config/loader')).clearConfigCache();
  const { deployInfra } = await import('../services/infraTemplates');
  await deployInfra({ deployDir });
}

describe.each(['mariadb', 'postgres'] as const)('init vs infra deploy (%s)', (dbType) => {
  it('init renders byte-identical files to `infra deploy` for the same answers', async () => {
    const c = answers({ dbType });
    const { renderInitInfraFiles } = await import('../cli/init');
    const fromInit = renderInitInfraFiles(c);
    expect(fromInit.length).toBeGreaterThan(0);

    await deployFromInitYaml(c);

    for (const f of fromInit) {
      const onDisk = await fs.readFile(path.join(deployDir, f.dest), 'utf-8');
      expect(onDisk, f.dest).toBe(f.content);
    }
  });
});

describe('init output content', () => {
  it('uses the reference versions, the shared letsencrypt volume and a read-write overwatch.yaml mount', async () => {
    const { renderInitInfraFiles } = await import('../cli/init');
    const files = Object.fromEntries(renderInitInfraFiles(answers()).map(f => [f.dest, f.content]));
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
    const files = Object.fromEntries(renderInitInfraFiles(answers({ dbType: 'postgres' })).map(f => [f.dest, f.content]));
    expect(files['infrastructure/docker-compose.yml']).toContain('image: postgres:16');
    expect(files['overwatch/docker-compose.yml']).toContain('POSTGRES_PASSWORD');
  });
});
