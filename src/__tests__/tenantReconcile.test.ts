import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';

/**
 * Start and restart regenerate the tenant's compose file from its definition
 * and its current Traefik overrides, so routing changes (host aliases,
 * middleware overrides) reach a running tenant, as the UI promises.
 */

let tmpRoot: string;
let appsDir: string;
let tenantPath: string;
let tenantTraefik: any;
let globalApp: any;
const calls: Array<{ args: string[]; compose?: string }> = [];
const logins: string[] = [];

function app(services?: any[]) {
  return {
    id: 'shop', name: 'Shop', domain_template: '*.example.test',
    registry: { type: 'ghcr', url: 'ghcr.io', repository: 'acme/shop', auth: { type: 'token' } },
    services: services ?? [{
      name: 'web', image_suffix: 'web', required: true, ports: { internal: 3000 },
      routing: { enabled: true, strip_prefix: false },
      volumes: [{ name: 'uploads', container_path: '/data' }],
    }],
    default_image_tag: 'latest', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  } as any;
}

const config = {
  project: { name: 'T', prefix: 'test', db_prefix: 'test' },
  database: { type: 'mariadb', host: 'db', port: 3306 },
  networking: { external_network: 'test-network' },
  traefik: { log_level: 'INFO', tls_termination: 'upstream', upstream_entrypoint: 'web' },
};

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-reconcile-'));
  appsDir = path.join(tmpRoot, 'apps');
  tenantPath = path.join(appsDir, 'shop', 'tenants', 't1');
  calls.length = 0;
  logins.length = 0;
  tenantTraefik = undefined;
  globalApp = app();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.doMock('../utils/runDocker', async () => ({
    ...(await vi.importActual<object>('../utils/runDocker')),
    runDocker: vi.fn(async (_cmd: string, args: string[]) => {
      const f = args.indexOf('-f');
      const compose = f >= 0 ? await fs.readFile(args[f + 1], 'utf-8') : undefined;
      calls.push({ args, compose });
      return { stdout: '', stderr: '' };
    }),
  }));
  vi.doMock('../config', () => ({ loadConfig: () => config, getAppsDir: () => appsDir, getDataDir: () => path.join(tmpRoot, 'data') }));
  vi.doMock('../config/loader', () => ({ loadConfig: () => config, resolveCertResolver: () => ({ name: 'web', resolver: null }) }));
  vi.doMock('../services/app', () => ({ getApp: vi.fn(async () => globalApp), listApps: vi.fn(async () => [globalApp]) }));
  vi.doMock('../services/tenantTraefik', () => ({ readTenantTraefik: vi.fn(async () => tenantTraefik) }));
  vi.doMock('../adapters/registry', () => ({
    ensureRegistryLogin: vi.fn(async (a: any) => { logins.push(`${a.id}@${calls.length}`); }),
  }));
  await fs.mkdir(tenantPath, { recursive: true });
  await fs.writeFile(path.join(tenantPath, '.env'), 'TENANT_DOMAIN=t1.example.test\nIMAGE_TAG=v1\n');
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
  for (const m of ['../utils/runDocker', '../config', '../config/loader', '../services/app', '../services/tenantTraefik', '../adapters/registry']) vi.doUnmock(m);
});

/** The tenant's compose file as it was generated before any override was set. */
async function writeCurrentCompose(existing?: string) {
  const { generateComposeFile } = await import('../services/composeGenerator');
  const text = generateComposeFile({ app: app(), tenantId: 't1', domain: 't1.example.test', config: config as any, existingCompose: existing });
  await fs.writeFile(path.join(tenantPath, 'docker-compose.yml'), text);
  return text;
}

const labelsAtUp = () => {
  const up = calls.find(c => c.args.includes('up'))!;
  return (yaml.load(up.compose!) as any).services.web.labels as string[];
};

describe('tenant start/restart apply the current compose definition', () => {
  it('restart regenerates the compose file with a new host alias, then recreates the containers', async () => {
    await writeCurrentCompose();
    tenantTraefik = { host_aliases: ['alias.example.test'] };
    const { restartTenant } = await import('../services/docker');
    await restartTenant('shop', 't1');

    expect(calls.find(c => c.args.includes('up'))!.args).toEqual(expect.arrayContaining(['up', '-d', '--force-recreate']));
    expect(labelsAtUp().some(l => l.includes('Host(`alias.example.test`)'))).toBe(true);
  });

  it('start regenerates too, and a removed alias is gone', async () => {
    tenantTraefik = { host_aliases: ['alias.example.test'] };
    const { generateComposeFile } = await import('../services/composeGenerator');
    await fs.writeFile(path.join(tenantPath, 'docker-compose.yml'),
      generateComposeFile({ app: app(), tenantId: 't1', domain: 't1.example.test', config: config as any, tenantTraefik }));
    tenantTraefik = undefined;
    const { startTenant } = await import('../services/docker');
    await startTenant('shop', 't1');

    expect(calls.find(c => c.args.includes('up'))!.args).toEqual(expect.arrayContaining(['up', '-d']));
    expect(labelsAtUp().some(l => l.includes('alias.example.test'))).toBe(false);
  });

  it('keeps the volume names the tenant already uses', async () => {
    const legacy = 'services:\n  web:\n    image: x\n    volumes:\n      - uploads:/data\nvolumes:\n  uploads:\n    name: uploads\n';
    await fs.writeFile(path.join(tenantPath, 'docker-compose.yml'), legacy);
    const { restartTenant } = await import('../services/docker');
    await restartTenant('shop', 't1');

    const doc = yaml.load(calls.find(c => c.args.includes('up'))!.compose!) as any;
    expect(doc.services.web.volumes).toEqual(['uploads:/data']);
    expect(doc.volumes).toEqual({ uploads: { external: true } });
  });

  it.each(['startTenant', 'restartTenant'] as const)('%s logs in to the app registry before compose up, which may pull', async (fn) => {
    await writeCurrentCompose();
    const docker = await import('../services/docker');
    await docker[fn]('shop', 't1');

    const upIndex = calls.findIndex(c => c.args.includes('up'));
    expect(logins).toEqual([`shop@${upIndex}`]);
  });

  it('starts a tenant without any app definition with its existing compose file', async () => {
    globalApp = null;
    const existing = 'services:\n  web:\n    image: x\n';
    await fs.writeFile(path.join(tenantPath, 'docker-compose.yml'), existing);
    const { startTenant } = await import('../services/docker');
    await startTenant('shop', 't1');

    expect(calls.find(c => c.args.includes('up'))!.compose).toBe(existing);
  });

  it('fails a restart whose definition cannot be rendered, leaving the compose file and containers alone', async () => {
    const before = await writeCurrentCompose();
    globalApp = app([{ name: 'web', image_suffix: 'web', depends_on: ['missing'] }]);
    const { restartTenant } = await import('../services/docker');
    await expect(restartTenant('shop', 't1')).rejects.toThrow(/missing/);

    expect(calls.some(c => c.args.includes('up'))).toBe(false);
    expect(await fs.readFile(path.join(tenantPath, 'docker-compose.yml'), 'utf-8')).toBe(before);
  });
});
