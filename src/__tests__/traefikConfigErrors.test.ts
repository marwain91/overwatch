import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import express from 'express';
import request from 'supertest';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let tmpRoot: string;
let configPath: string;

const BASE = {
  project: { name: 'Acme', prefix: 'acme', db_prefix: 'acme' },
  database: { type: 'mariadb', host: 'db', port: 3306, container_name: 'db', root_user_env: 'DB_ROOT_USER', root_password_env: 'DB_ROOT_PW' },
};

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-traefik-errors-'));
  configPath = path.join(tmpRoot, 'overwatch.yaml');
  await fs.mkdir(path.join(tmpRoot, 'data'), { recursive: true });
  await fs.writeFile(configPath, yaml.dump({ ...BASE, data_dir: path.join(tmpRoot, 'data') }));
  process.env.OVERWATCH_CONFIG = configPath;
  vi.doMock('../middleware/requireRole', () => ({ requireRole: () => (_q: any, _r: any, n: any) => n() }));
  vi.doMock('../services/app', () => ({ getApp: async () => null, applyApp: async () => ({}) }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  delete process.env.OVERWATCH_CONFIG;
  const { clearConfigCache } = await import('../config/loader');
  clearConfigCache();
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock('../middleware/requireRole');
  vi.doUnmock('../services/app');
});

describe('traefik config typed errors', () => {
  it('getAppTraefik / updateAppTraefik for an unknown app are NotFoundError', async () => {
    const { getAppTraefik, updateAppTraefik } = await import('../services/traefikConfig');
    const { NotFoundError } = await import('../utils/httpErrors');
    await expect(getAppTraefik('ghost')).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateAppTraefik('ghost', {})).rejects.toBeInstanceOf(NotFoundError);
  });

  it('a config that would be invalid is a ValidationError from the writer', async () => {
    const { writeOverwatchConfig } = await import('../config/writer');
    const { ValidationError } = await import('../utils/httpErrors');
    await expect(writeOverwatchConfig({ project: {} })).rejects.toBeInstanceOf(ValidationError);
  });

  it('PUT /apps/:id/traefik for an unknown app returns 404 and an invalid global config returns 400', async () => {
    const { errorHandler } = await import('../middleware/errorHandler');
    const apps = (await import('../routes/apps')).default;
    const traefik = (await import('../routes/traefik')).default;
    const server = express();
    server.use(express.json());
    server.use('/apps', apps);
    server.use('/traefik', traefik);
    server.use(errorHandler);
    const notFound = await request(server).put('/apps/ghost/traefik').send({});
    expect(notFound.status).toBe(404);
    expect(notFound.body.error).toContain('ghost');
    const invalid = await request(server).put('/traefik/overwatch').send({ host: 5 });
    expect(invalid.status).toBe(400);
  });

  it('a mutation that leaves overwatch.yaml invalid is a ValidationError', async () => {
    const { updateOverwatchConfig } = await import('../config/writer');
    const { ValidationError } = await import('../utils/httpErrors');
    await expect(updateOverwatchConfig(raw => { raw.project = {}; })).rejects.toBeInstanceOf(ValidationError);
  });
});
