import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// The audit log's key-name denylist does not know Traefik credential fields
// (htpasswd `users`, forwardAuth addresses, raw `*.basicauth.users` labels,
// DNS provider env), so Traefik-bearing bodies are masked with the same
// allowlist as the read APIs before they are written to audit.log.

let tmpRoot: string;
let dataDir: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-audit-traefik-'));
  dataDir = path.join(tmpRoot, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  vi.doMock('../config', () => ({ getDataDir: () => dataDir }));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.resetModules();
  vi.doUnmock('../config');
});

const SECRETS = /\$apr1\$|\$2y\$|tok3n|gce-secret|sk-live|hdr-secret/;
const MIDDLEWARES = {
  gate: { type: 'basicAuth', users: ['alice:$apr1$hashhash'] },
  sso: { type: 'forwardAuth', address: 'https://svc:tok3n@auth.example.com/verify' },
  hdr: { type: 'headers', custom_request_headers: { 'X-Api-Key': 'hdr-secret' } },
  rl: { type: 'rateLimit', average: 10 },
};
const LABELS = {
  'traefik.http.middlewares.x.basicauth.users': 'bob:$2y$10$abcdef',
  'traefik.http.routers.x.priority': '5',
};

async function audit(method: string, baseUrl: string, p: string, body: unknown) {
  const { auditLog } = await import('../middleware/audit');
  const { flushAuditLog } = await import('../services/auditLog');
  const req: any = { method, baseUrl, path: p, query: {}, body, ip: '1.2.3.4', socket: { remoteAddress: '1.2.3.4' } };
  const res: any = { statusCode: 200, json: (b: any) => b, locals: { user: { email: 'a@b.c', role: 'admin' } } };
  auditLog(req, res, () => {});
  res.json({ ok: true });
  await flushAuditLog();
  const lines = (await fs.readFile(path.join(dataDir, 'audit.log'), 'utf-8')).trim().split('\n');
  return { raw: lines[lines.length - 1], entry: JSON.parse(lines[lines.length - 1]) };
}

describe('Traefik bodies are masked before auditing', () => {
  it.each([
    ['PUT /api/traefik', 'PUT', '/api/traefik', '/', {
      log_level: 'INFO', middlewares: MIDDLEWARES,
      cert_resolvers: [{ name: 'dns', challenge: 'dns', provider: 'gcloud', acme_email: 'a@b.c', env: { GCE_SERVICE_ACCOUNT: 'gce-secret' } }],
      overwatch: { host: 'ow.example.com', raw_labels: LABELS },
    }],
    ['POST /api/traefik/validate', 'POST', '/api/traefik', '/validate', { middlewares: MIDDLEWARES, dashboard: { raw_labels: LABELS } }],
    ['PUT /api/traefik/middlewares/:name', 'PUT', '/api/traefik', '/middlewares/gate', MIDDLEWARES.gate],
    ['POST /api/traefik/middlewares/:name', 'POST', '/api/traefik', '/middlewares/sso', MIDDLEWARES.sso],
    ['PUT /api/traefik/overwatch', 'PUT', '/api/traefik', '/overwatch', { host: 'ow.example.com', raw_labels: LABELS }],
    ['PUT /api/traefik/dashboard', 'PUT', '/api/traefik', '/dashboard', { enabled: true, raw_labels: LABELS }],
    ['PUT /api/traefik/cert-resolvers/:name', 'PUT', '/api/traefik', '/cert-resolvers/dns',
      { name: 'dns', challenge: 'dns', provider: 'gcloud', acme_email: 'a@b.c', env: { GCE_SERVICE_ACCOUNT: 'gce-secret' } }],
    ['PUT /api/apps/:id/traefik', 'PUT', '/api/apps', '/demo/traefik', { middlewares: MIDDLEWARES, default_middlewares: ['gate'] }],
    ['PUT /api/apps/:id/tenants/:tid/traefik', 'PUT', '/api/apps/demo/tenants', '/t1/traefik', { raw_labels: { web: LABELS } }],
    ['POST /api/apps', 'POST', '/api/apps', '/', {
      id: 'demo', traefik: { middlewares: MIDDLEWARES },
      services: [{ name: 'web', routing: { raw_labels: LABELS }, env_mapping: { API: { static: 'sk-live-1' } } }],
    }],
    ['PUT /api/apps/:id', 'PUT', '/api/apps', '/demo', {
      services: [{ name: 'web', env_mapping: { API: { static: 'sk-live-1' }, DB_HOST: 'DB_HOST' } }],
    }],
  ])('%s', async (_name, method, baseUrl, p, body) => {
    const { raw, entry } = await audit(method, baseUrl, p, body);
    expect(raw).not.toMatch(SECRETS);
    expect(entry.body).toBeTruthy();
    expect(entry.path).toBe(baseUrl + p);
  });

  it('keeps the non-secret shape readable', async () => {
    const { entry } = await audit('PUT', '/api/apps', '/demo/traefik', { middlewares: MIDDLEWARES, default_middlewares: ['gate'] });
    expect(entry.body.default_middlewares).toEqual(['gate']);
    // The audit log's own key denylist then redacts `users` entirely.
    expect(entry.body.middlewares.gate.users).toBe('[redacted]');
    expect(entry.body.middlewares.rl).toEqual({ type: 'rateLimit', average: 10 });
  });

  it('a body that cannot be masked is not written as is', async () => {
    const { raw } = await audit('PUT', '/api/traefik', '/', { middlewares: { gate: null, x: 'alice:$apr1$hashhash' } });
    expect(raw).not.toMatch(SECRETS);
  });

  it('leaves other bodies to the denylist', async () => {
    const { entry } = await audit('POST', '/api/apps/demo/tenants', '/', { tenantId: 't9', domain: 't9.example.com' });
    expect(entry.body).toEqual({ tenantId: 't9', domain: 't9.example.com' });
  });
});
