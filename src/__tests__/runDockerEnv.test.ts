import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const execFileMock = vi.fn();
vi.mock('child_process', () => ({ execFile: (...a: unknown[]) => execFileMock(...a) }));

import { getDockerEnv, runDocker } from '../utils/runDocker';

const SAVED = { ...process.env };

describe('getDockerEnv', () => {
  beforeEach(() => {
    process.env.PATH = '/usr/bin';
    process.env.HOME = '/home/ow';
    process.env.DOCKER_HOST = 'tcp://docker:2376';
    process.env.DOCKER_CONFIG = '/home/ow/.docker';
    process.env.DOCKER_CERT_PATH = '/certs';
    process.env.DOCKER_TLS_VERIFY = '1';
    process.env.COMPOSE_PROFILES = 'prod';
    process.env.JWT_SECRET = 'super-secret';
    process.env.MYSQL_ROOT_PASSWORD = 'root-pw';
    process.env.GHCR_TOKEN = 'ghp_x';
    process.env.R2_SECRET_ACCESS_KEY = 'r2';
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
    Object.assign(process.env, SAVED);
  });

  it('keeps only what the docker CLI and compose need', () => {
    const env = getDockerEnv();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/ow');
    expect(env.DOCKER_HOST).toBe('tcp://docker:2376');
    expect(env.DOCKER_CONFIG).toBe('/home/ow/.docker');
    expect(env.DOCKER_CERT_PATH).toBe('/certs');
    expect(env.DOCKER_TLS_VERIFY).toBe('1');
  });

  it('forwards non-selection COMPOSE_* tuning and DOCKER_* by prefix', () => {
    process.env.COMPOSE_HTTP_TIMEOUT = '300';
    process.env.COMPOSE_PARALLEL_LIMIT = '2';
    process.env.COMPOSE_ANSI = 'never';
    process.env.DOCKER_API_VERSION = '1.43';
    process.env.DOCKER_CLI_EXPERIMENTAL = 'enabled';
    const env = getDockerEnv();
    expect(env.COMPOSE_HTTP_TIMEOUT).toBe('300');
    expect(env.COMPOSE_PARALLEL_LIMIT).toBe('2');
    expect(env.COMPOSE_ANSI).toBe('never');
    expect(env.DOCKER_API_VERSION).toBe('1.43');
    expect(env.DOCKER_CLI_EXPERIMENTAL).toBe('enabled');
  });

  it('never forwards compose selection variables that would override per-tenant settings', () => {
    for (const k of ['COMPOSE_PROJECT_NAME', 'COMPOSE_FILE', 'COMPOSE_PROFILES', 'COMPOSE_PATH_SEPARATOR',
      'COMPOSE_ENV_FILES', 'COMPOSE_REMOVE_ORPHANS', 'COMPOSE_IGNORE_ORPHANS', 'COMPOSE_SOMETHING_NEW']) {
      process.env[k] = 'x';
    }
    const env = getDockerEnv();
    expect(Object.keys(env).filter(k => k.startsWith('COMPOSE_'))).toEqual([]);
  });

  it('builds exactly the expected env', () => {
    const only = { PATH: '/p', HOME: '/h', COMPOSE_HTTP_TIMEOUT: '9', COMPOSE_PROJECT_NAME: 'x', DOCKER_HOST: 'h', JWT_SECRET: 's', COMPOSE_FILE: 'f' };
    expect(getDockerEnv(only)).toEqual({ PATH: '/p', HOME: '/h', COMPOSE_HTTP_TIMEOUT: '9', DOCKER_HOST: 'h' });
  });

  it('drops Overwatch secrets', () => {
    const env = getDockerEnv();
    for (const k of ['JWT_SECRET', 'MYSQL_ROOT_PASSWORD', 'GHCR_TOKEN', 'R2_SECRET_ACCESS_KEY']) {
      expect(env).not.toHaveProperty(k);
    }
  });

  it('runDocker spawns with the curated env by default', async () => {
    execFileMock.mockImplementation((_c: string, _a: string[], _o: any, cb: any) => { cb(null, '', ''); return { on() {} }; });
    await runDocker('docker', ['ps']);
    const opts = execFileMock.mock.calls[0][2];
    expect(opts.env.PATH).toBe('/usr/bin');
    expect(opts.env).not.toHaveProperty('JWT_SECRET');
  });

  it('runDocker honours an explicit env', async () => {
    execFileMock.mockImplementation((_c: string, _a: string[], _o: any, cb: any) => { cb(null, '', ''); return { on() {} }; });
    await runDocker('docker', ['ps'], { env: { X: '1' } });
    expect(execFileMock.mock.calls.at(-1)![2].env).toEqual({ X: '1' });
  });
});
