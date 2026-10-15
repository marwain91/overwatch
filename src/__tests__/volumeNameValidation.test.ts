import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import express from 'express';
import request from 'supertest';
import { CreateAppSchema, UpdateAppSchema, AppDefinitionStaticSchema } from '../models/app';
import { assertVolumeNamesValid } from '../utils/validators';
import { ValidationError } from '../utils/httpErrors';

/**
 * A volume `name` or `name_template` that is not a plain Docker volume name
 * becomes a host bind mount in the tenant compose file (`/var/run/docker.sock`).
 * Write paths refuse such names; stored definitions keep loading.
 */

function def(volumes: unknown[]) {
  return {
    id: 'demo', name: 'Demo', domain_template: '*.demo.example',
    registry: { type: 'ghcr', url: 'ghcr.io', repository: 'ns/demo', auth: { type: 'token' } },
    services: [{ name: 'web', image_suffix: 'web', ports: { internal: 80 }, volumes }],
    default_image_tag: 'latest',
  };
}

const BIND_LIKE = ['/var/run/docker.sock', './data', '../data', '~/data', 'data:/etc', '${HOME}', '.hidden', 'a b'];

describe('volume names on app definition write paths', () => {
  it.each(BIND_LIKE)('create and update refuse volume name %j', (name) => {
    for (const schema of [CreateAppSchema, UpdateAppSchema]) {
      const result = schema.safeParse(def([{ name, container_path: '/x' }]));
      expect(result.success).toBe(false);
      expect(result.error!.errors[0].path).toEqual(['services', 0, 'volumes', 0, 'name']);
    }
  });

  it('refuses a name_template that renders to a host path', () => {
    const result = CreateAppSchema.safeParse(def([{ name: 'x', container_path: '/x', name_template: '/srv/${tenantId}' }]));
    expect(result.success).toBe(false);
    expect(result.error!.errors[0].path).toEqual(['services', 0, 'volumes', 0, 'name_template']);
  });

  it('accepts plain names and templates with placeholders', () => {
    const ok = def([
      { name: 'uploads', container_path: '/a' },
      { name: 'media', container_path: '/b', name_template: '${appId}-${tenantId}-media' },
      { name: 'Shared_1.cache', container_path: '/c', external: true },
    ]);
    expect(CreateAppSchema.safeParse(ok).success).toBe(true);
    expect(UpdateAppSchema.safeParse({ id: 'demo', name: 'Renamed' }).success).toBe(true);
  });

  it('still loads a stored definition that predates the check', () => {
    expect(AppDefinitionStaticSchema.safeParse(def([{ name: '/var/run/docker.sock', container_path: '/sock' }])).success).toBe(true);
  });

  it('assertVolumeNamesValid (CLI path) applies the same rule', () => {
    expect(() => assertVolumeNamesValid(def([{ name: '/var/run/docker.sock', container_path: '/sock' }]).services)).toThrow(ValidationError);
    expect(() => assertVolumeNamesValid(def([{ name: '/var/run/docker.sock', container_path: '/sock' }]).services)).toThrow(/services\.0\.volumes\.0\.name/);
    expect(() => assertVolumeNamesValid(def([{ name: 'ok', container_path: '/x' }]).services)).not.toThrow();
  });
});

describe('POST /api/apps and PUT /api/apps/:appId', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-volume-names-'));
    const dataDir = path.join(tmpRoot, 'data');
    const appsDir = path.join(tmpRoot, 'apps');
    await fs.mkdir(path.join(dataDir, 'apps.d'), { recursive: true });
    await fs.mkdir(appsDir, { recursive: true });
    vi.doMock('../config', () => ({
      getDataDir: () => dataDir,
      getAppsDir: () => appsDir,
      loadConfig: () => ({ project: { name: 'T', prefix: 'test', db_prefix: 'test' } }),
      resolveAppDbPrefix: () => 'test',
    }));
    vi.doMock('../config/loader', () => ({ getAppsDir: () => appsDir, resolveCertResolver: () => ({ name: 'web', resolver: null }) }));
    vi.doMock('../services/fileLock', () => ({ withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn() }));
    vi.doMock('../middleware/requireRole', () => ({ requireRole: () => (_req: any, _res: any, next: any) => next() }));
    vi.doMock('../adapters/registry', () => ({ getImageTagsForApp: async () => [], clearAdapterCache: vi.fn() }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    vi.resetModules();
    vi.restoreAllMocks();
    for (const m of ['../config', '../config/loader', '../services/fileLock', '../middleware/requireRole', '../adapters/registry']) vi.doUnmock(m);
  });

  it('answer 400 for a volume name that would mount a host path', async () => {
    const { errorHandler } = await import('../middleware/errorHandler');
    const { default: appsRouter } = await import('../routes/apps');
    const app = express();
    app.use(express.json());
    app.use('/api/apps', appsRouter);
    app.use(errorHandler);

    const created = await request(app).post('/api/apps').send(def([{ name: '/var/run/docker.sock', container_path: '/sock' }])).expect(400);
    expect(created.body.error).toMatch(/services\.0\.volumes\.0\.name/);

    await request(app).post('/api/apps').send(def([{ name: 'data', container_path: '/data' }])).expect(201);
    const updated = await request(app).put('/api/apps/demo').send({ services: def([{ name: './data', container_path: '/data' }]).services }).expect(400);
    expect(updated.body.error).toMatch(/services\.0\.volumes\.0\.name/);
  });
});

describe('overwatch apps apply', { timeout: 60_000 }, () => {
  const cliEntry = path.resolve(__dirname, '..', 'cli.ts');
  beforeAll(() => {
    spawnSync(process.execPath, ['--import', 'tsx', cliEntry, '--help'], { encoding: 'utf-8' });
  }, 180_000);

  it('refuses a volume name that would mount a host path', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-volume-cli-'));
    try {
      const dataDir = path.join(tmp, 'data');
      await fs.mkdir(path.join(dataDir, 'apps.d'), { recursive: true });
      const configPath = path.join(tmp, 'overwatch.yaml');
      await fs.writeFile(configPath, [
        'project: { name: "Test", prefix: "test", db_prefix: "test" }',
        'database: { type: "mariadb", host: "h", port: 3306, root_user: "root", root_password_env: "MYSQL_ROOT_PASSWORD", container_name: "c" }',
        `networking: { external_network: "test-network", apps_path: "${path.join(tmp, 'apps')}" }`,
        `data_dir: "${dataDir}"`,
        '',
      ].join('\n'));
      const appFile = path.join(tmp, 'demo.json');
      await fs.writeFile(appFile, JSON.stringify(def([{ name: '/var/run/docker.sock', container_path: '/sock' }])));

      const proc = spawnSync(process.execPath, ['--import', 'tsx', cliEntry, 'apps', 'apply', appFile], {
        encoding: 'utf-8',
        env: { ...process.env, OVERWATCH_CONFIG: configPath, FORCE_COLOR: '0', NO_COLOR: '1' },
      });
      expect(proc.status).toBe(2);
      expect(proc.stderr).toMatch(/volume name/);
      await expect(fs.stat(path.join(dataDir, 'apps.d', 'demo.json'))).rejects.toThrow();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
