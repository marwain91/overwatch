import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import express from 'express';
import request from 'supertest';

// DNS provider variable names do not reliably say which values are secret, so
// non-admins get every cert-resolver env value masked; the masked value an
// admin reads back is never stored over the real one.

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const MASK = '••••••••';
const ENV = {
  CF_DNS_API_TOKEN: 'cf-secret',
  GCE_SERVICE_ACCOUNT: '{"private_key":"gce-secret"}',
  HURRICANE_TOKENS: 'example.org:he-secret',
  EPIK_SIGNATURE: 'epik-secret',
  HYPERONE_PASSPHRASE: 'h1-secret',
  GCE_PROJECT: 'my-project',
};
const LEAKS = /cf-secret|gce-secret|he-secret|epik-secret|h1-secret|my-project/;
const DNS = { name: 'dns', challenge: 'dns', provider: 'gcloud', acme_email: 'ops@example.com', env: ENV };
const HTTP = { name: 'http', challenge: 'http', acme_email: 'ops@example.com', entrypoint: 'web' };

describe('reads', () => {
  afterEach(() => { vi.resetModules(); vi.doUnmock('../config/loader'); vi.doUnmock('../services/app'); });

  async function as(role: 'viewer' | 'editor' | 'admin') {
    vi.doMock('../config/loader', () => ({ loadConfig: () => ({ traefik: { cert_resolvers: [DNS, HTTP] } }) }));
    vi.doMock('../services/app', () => ({ getApp: async () => null, applyApp: async () => ({}) }));
    const { default: router } = await import('../routes/traefik');
    const app = express();
    app.use((_req, res, next) => { res.locals.user = { email: 'u@example.test', role }; next(); });
    app.use('/api/traefik', router);
    return app;
  }

  it.each(['viewer', 'editor'] as const)('%s gets every env value masked on / and /cert-resolvers', async (role) => {
    const app = await as(role);
    const full = (await request(app).get('/api/traefik').expect(200)).body;
    const list = (await request(app).get('/api/traefik/cert-resolvers').expect(200)).body;
    for (const resolvers of [full.cert_resolvers, list]) {
      expect(JSON.stringify(resolvers)).not.toMatch(LEAKS);
      expect(resolvers[0].env).toEqual(Object.fromEntries(Object.keys(ENV).map(k => [k, MASK])));
      expect(resolvers[0].provider).toBe('gcloud');
      expect(resolvers[1]).toEqual(HTTP);
    }
  });

  it('admins keep the existing view: secret-looking names masked, the rest shown', async () => {
    const list = (await request(await as('admin')).get('/api/traefik/cert-resolvers').expect(200)).body;
    expect(list[0].env.CF_DNS_API_TOKEN).toBe(MASK);
    expect(list[0].env.GCE_PROJECT).toBe('my-project');
  });
});

describe('writes keep the stored value behind a masked one', () => {
  let tmpRoot: string;
  let configPath: string;
  const BASE = {
    project: { name: 'Acme', prefix: 'acme', db_prefix: 'acme' },
    database: { type: 'mariadb', host: 'db', port: 3306, container_name: 'db', root_user_env: 'DB_ROOT_USER', root_password_env: 'DB_ROOT_PW' },
  };
  const stored = () => (yaml.load(fsSync.readFileSync(configPath, 'utf-8')) as any).traefik;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-resolver-env-'));
    configPath = path.join(tmpRoot, 'overwatch.yaml');
    await fs.mkdir(path.join(tmpRoot, 'data'), { recursive: true });
    await fs.writeFile(configPath, yaml.dump({ ...BASE, data_dir: path.join(tmpRoot, 'data'), traefik: { cert_resolvers: [DNS, HTTP] } }));
    process.env.OVERWATCH_CONFIG = configPath;
  });

  afterEach(async () => {
    delete process.env.OVERWATCH_CONFIG;
    const { clearConfigCache } = await import('../config/loader');
    clearConfigCache();
    await fs.rm(tmpRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  it('upserting a resolver read back from the API', async () => {
    const { listCertResolvers, upsertCertResolver } = await import('../services/traefikConfig');
    const [read] = await listCertResolvers();
    expect((read as any).env.CF_DNS_API_TOKEN).toBe(MASK);
    const saved = await upsertCertResolver('dns', { ...read, acme_email: 'new@example.com' });
    expect(stored().cert_resolvers[0]).toEqual({ ...DNS, acme_email: 'new@example.com' });
    expect(JSON.stringify(saved)).not.toMatch(/cf-secret/);
  });

  it('saving the full config read back from the API (the entrypoints and TLS editors do this)', async () => {
    const { getTraefikConfig, updateTraefikConfig } = await import('../services/traefikConfig');
    const read = (await getTraefikConfig())!;
    await updateTraefikConfig({ ...read, entrypoints: [{ name: 'web', port: 80 }] });
    expect(stored().cert_resolvers[0].env).toEqual(ENV);
    expect(stored().entrypoints).toEqual([{ name: 'web', port: 80 }]);
  });

  it('a masked value with nothing stored to keep is refused', async () => {
    const { upsertCertResolver, updateTraefikConfig } = await import('../services/traefikConfig');
    const { ValidationError } = await import('../utils/httpErrors');
    await expect(upsertCertResolver('fresh', { ...DNS, name: 'fresh', env: { CF_DNS_API_TOKEN: MASK } }))
      .rejects.toBeInstanceOf(ValidationError);
    await expect(updateTraefikConfig({ log_level: 'INFO', cert_resolvers: [{ ...DNS, env: { NEW_KEY: MASK } }] } as any))
      .rejects.toThrow(/masked placeholder/);
    expect(stored().cert_resolvers[0].env).toEqual(ENV);
  });
});
