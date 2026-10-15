import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { AppDefinition } from '../models/app';
import {
  rawLabelProblem,
  rawLabelOwnerForRouter,
  credentialedAnyOriginProblems,
  type RawLabelOwner,
} from '../models/traefik';

// A tenant's own raw labels (editor-writable) may configure safe middleware
// types, but not with values that send users or their credentials elsewhere.

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const M = 'traefik.http.middlewares.myapp-t1-web-x';
const HOSTS = ['t1.app.example.com', 'alias.app.example.com'];
const tenantOwner: RawLabelOwner = {
  ...rawLabelOwnerForRouter('myapp-t1-web'),
  tenant: { hosts: HOSTS, requiredMiddlewares: [], protectedMiddlewares: [] },
};
const appOwner = rawLabelOwnerForRouter('myapp-t1-web');
const problem = (key: string, value: string, owner = tenantOwner) => rawLabelProblem(key, value, owner);

describe('redirectregex replacement', () => {
  const key = `${M}.redirectregex.replacement`;

  it.each([
    '/login', '/$1', '/new/${1}', 'https://t1.app.example.com/$1', 'https://ALIAS.app.example.com/x',
    'http://t1.app.example.com:8080/', 'https://t1.app.example.com./x',
  ])('allows %j', (value) => {
    expect(problem(key, value)).toBeUndefined();
  });

  it.each([
    'https://collector.example.net/login', '//collector.example.net/', '/\\collector.example.net',
    'https://t1.app.example.com@collector.example.net/', 'https:\\\\collector.example.net', 'https://$1/',
    '$1', 'javascript:alert(1)', 'collector.example.net/x', '/\t/collector.example.net', ' //collector.example.net',
    'ftp://t1.app.example.com/',
  ])('refuses %j', (value) => {
    expect(problem(key, value)).toMatch(/redirect/);
  });

  it('indexed and mixed-case keys are checked too', () => {
    expect(problem(`${M}.RedirectRegex.Replacement`, 'https://collector.example.net/')).toMatch(/redirect/);
  });

  it('app-level labels (admin-owned) are not restricted', () => {
    expect(problem(key, 'https://www.example.org/$1', appOwner)).toBeUndefined();
  });
});

describe('headers middleware', () => {
  it.each([
    'X-Forwarded-User', 'x_forwarded_user', 'X-Forwarded-Email', 'X-Remote-User', 'Remote-User',
    'X-Auth-Request-Email', 'X-Webauth-User', 'Authorization', 'Proxy-Authorization', 'Cookie', 'X-User',
  ])('refuses the identity request header %s', (name) => {
    expect(problem(`${M}.headers.customrequestheaders.${name}`, 'admin@example.com')).toMatch(/identity/);
    expect(problem(`${M}.headers.customrequestheaders.${name}`, 'admin@example.com', appOwner)).toBeUndefined();
  });

  it('allows other request headers', () => {
    expect(problem(`${M}.headers.customrequestheaders.X-Tenant`, 't1')).toBeUndefined();
  });

  it.each(['Content-Security-Policy', 'strict-transport-security', 'X-Frame-Options'])(
    'refuses deleting the security response header %s', (name) => {
      expect(problem(`${M}.headers.customresponseheaders.${name}`, '')).toMatch(/security/);
      expect(problem(`${M}.headers.customresponseheaders.${name}`, '  ')).toMatch(/security/);
      expect(problem(`${M}.headers.customresponseheaders.${name}`, '', appOwner)).toBeUndefined();
    });

  it('allows setting them, and deleting other response headers', () => {
    expect(problem(`${M}.headers.customresponseheaders.Content-Security-Policy`, "default-src 'self'")).toBeUndefined();
    expect(problem(`${M}.headers.customresponseheaders.X-Powered-By`, '')).toBeUndefined();
  });
});

describe('credentialed CORS with any origin', () => {
  const C = `${M}.headers.accesscontrolallowcredentials`;
  const O = `${M}.headers.accesscontrolalloworiginlist`;

  it.each([
    [{ [C]: 'true', [O]: '*' }],
    [{ [C]: 'TRUE', [O]: 'https://a.example.com, *' }],
    [{ [C]: '1', [`${O}[0]`]: 'null' }],
    [{ [C]: 'true', [`${M}.headers.accessControlAllowOriginListRegex`]: '^https://.*$' }],
  ])('flags %j', (labels) => {
    const flagged = credentialedAnyOriginProblems(labels);
    expect([...flagged.keys()].sort()).toEqual(Object.keys(labels).sort());
    for (const p of flagged.values()) expect(p).toMatch(/origin/);
  });

  it.each([
    [{ [C]: 'true', [O]: 'https://a.example.com' }],
    [{ [C]: 'false', [O]: '*' }],
    [{ [O]: '*' }],
    [{ [C]: 'true', [O]: 'https://b.example.com', 'traefik.http.middlewares.myapp-t1-web-y.headers.accesscontrolalloworiginlist': '*' }],
  ])('passes %j', (labels) => {
    expect(credentialedAnyOriginProblems(labels).size).toBe(0);
  });
});

const app = {
  id: 'myapp', name: 'MyApp', domain_template: '*.app.example.com',
  registry: { type: 'ghcr', url: 'ghcr.io', repository: 'ns/myapp', auth: { type: 'token' } },
  services: [], default_image_tag: 'latest',
} as unknown as AppDefinition;

describe('generation', () => {
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

  async function build(appRaw: Record<string, string>, tenantRaw: Record<string, string>, aliases: string[] = []) {
    const { buildTraefikLabels } = await import('../services/traefikLabels');
    return buildTraefikLabels({
      app, tenantId: 't1', domain: 't1.app.example.com', certResolverName: 'cf',
      service: { name: 'web', required: true, is_init_container: false, ports: { internal: 80 },
        routing: { enabled: true, strip_prefix: false, raw_labels: appRaw } } as any,
      tenantOverrides: { host_aliases: aliases, raw_labels: { web: tenantRaw } },
    });
  }

  it('drops a tenant redirect off its hosts, keeps one to its alias, and leaves app labels alone', async () => {
    const labels = await build(
      { 'traefik.http.middlewares.myapp-t1-web-a.redirectregex.replacement': 'https://www.example.org/$1' },
      {
        [`${M}.redirectregex.replacement`]: 'https://collector.example.net/$1',
        'traefik.http.middlewares.myapp-t1-web-b.redirectregex.replacement': 'https://alias.app.example.com/$1',
      },
      ['alias.app.example.com'],
    );
    const joined = labels.join('\n');
    expect(joined).not.toContain('collector.example.net');
    expect(labels).toContain('traefik.http.middlewares.myapp-t1-web-b.redirectregex.replacement=https://alias.app.example.com/$1');
    expect(labels).toContain('traefik.http.middlewares.myapp-t1-web-a.redirectregex.replacement=https://www.example.org/$1');
  });

  it('drops the tenant half of a credentialed any-origin CORS setup split across the app and the tenant', async () => {
    const labels = await build(
      { [`${M}.headers.accesscontrolalloworiginlist`]: '*' },
      { [`${M}.headers.accesscontrolallowcredentials`]: 'true' },
    );
    expect(labels).toContain(`${M}.headers.accesscontrolalloworiginlist=*`);
    expect(labels.join('\n')).not.toContain('accesscontrolallowcredentials');
  });
});

describe('save time', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-tenant-values-'));
    const appsDir = path.join(tmpRoot, 'apps');
    const dir = path.join(appsDir, 'myapp', 'tenants', 't1');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, '.env'), 'TENANT_ID=t1\nTENANT_DOMAIN=t1.app.example.com\n');
    const cfg = { project: { name: 'T', prefix: 'test', db_prefix: 'test' }, traefik: { log_level: 'INFO' } };
    vi.doMock('../config', () => ({ getAppsDir: () => appsDir, getDataDir: () => tmpRoot, loadConfig: () => cfg }));
    vi.doMock('../config/loader', () => ({ getAppsDir: () => appsDir, loadConfig: () => cfg }));
    vi.doMock('../services/fileLock', () => ({ withFileLock: <T>(_n: string, fn: () => Promise<T>) => fn() }));
    vi.doMock('../services/app', () => ({ getApp: async () => app, applyApp: async () => ({}) }));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    vi.resetModules();
    vi.restoreAllMocks();
    for (const m of ['../config', '../config/loader', '../services/fileLock', '../services/app']) vi.doUnmock(m);
  });

  it.each([
    [{ [`${M}.redirectregex.replacement`]: 'https://collector.example.net/$1' }, /redirect/],
    [{ [`${M}.headers.customrequestheaders.X-Forwarded-User`]: 'admin' }, /identity/],
    [{ [`${M}.headers.customresponseheaders.Content-Security-Policy`]: '' }, /security/],
    [{ [`${M}.headers.accesscontrolallowcredentials`]: 'true', [`${M}.headers.accesscontrolalloworiginlist`]: '*' }, /origin/],
  ])('refuses %j with a 400', async (labels, msg) => {
    const { updateTenantTraefik } = await import('../services/traefikConfig');
    const { ValidationError } = await import('../utils/httpErrors');
    const p = updateTenantTraefik('myapp', 't1', { raw_labels: { web: labels } });
    await expect(p).rejects.toBeInstanceOf(ValidationError);
    await expect(p).rejects.toThrow(msg);
  });

  it('accepts a redirect to the tenant domain or to an alias saved in the same request', async () => {
    const { updateTenantTraefik } = await import('../services/traefikConfig');
    const body = {
      host_aliases: ['alias.app.example.com'],
      raw_labels: { web: {
        [`${M}.redirectregex.replacement`]: 'https://alias.app.example.com/$1',
        'traefik.http.middlewares.myapp-t1-web-y.redirectregex.replacement': 'https://T1.app.example.com/$1',
      } },
    };
    await expect(updateTenantTraefik('myapp', 't1', body)).resolves.toMatchObject(body);
  });
});
