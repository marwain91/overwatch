import { describe, it, expect } from 'vitest';
import { AppDefinitionStaticSchema, type AppDefinitionStatic } from '../models/app';
import { applyManifestPolicy, manifestPolicyBaseline } from '../services/manifestPolicy';

function def(input: Record<string, unknown>): AppDefinitionStatic {
  return AppDefinitionStaticSchema.parse(input);
}

const CURRENT_INPUT = {
  id: 'shop',
  name: 'Shop',
  domain_template: '*.shop.test',
  registry: { type: 'ghcr', url: 'ghcr.io', repository: 'acme/shop', auth: { type: 'token' } },
  services: [
    {
      name: 'backend',
      image_suffix: 'backend',
      required: true,
      user: '1000:1000',
      command: ['node', 'server.js'],
      ports: { internal: 3000 },
      health_check: { type: 'http', path: '/health' },
      env_mapping: { DATABASE_URL: 'DB_URL' },
      volumes: [{ name: 'uploads', container_path: '/app/uploads' }],
      networks: ['external', 'internal'],
      backup: { enabled: true, paths: [{ container: '/app/uploads', local: 'uploads' }] },
      routing: {
        path_prefix: '/api',
        middlewares: ['api-limit'],
        raw_labels: { 'traefik.http.routers.shop.priority': '10', 'traefik.http.services.shop.loadbalancer.sticky': 'true' },
        tls_termination: 'traefik',
      },
      depends_on: ['migrator'],
    },
    { name: 'migrator', image_suffix: 'backend', is_init_container: true, command: ['npm', 'run', 'migrate'] },
    { name: 'frontend', image_suffix: 'frontend', required: true, ports: { internal: 80 } },
  ],
  backup: { enabled: true, schedule: '0 3 * * *', provider: 's3' },
  admin_access: { enabled: true, secret_env: 'AUTH_SERVICE_SECRET' },
  credentials: { db_password_length: 32, jwt_secret_length: 64 },
  db_prefix: 'shop',
  traefik: {
    middlewares: { 'api-limit': { type: 'rateLimit', average: 100 } },
    default_middlewares: ['api-limit'],
  },
  manifest: { image_suffix: 'backend', path: '/overwatch/app.json' },
  env_vars: [{ key: 'SMTP_HOST', description: 'SMTP relay' }],
  default_image_tag: '1.0.0',
};

const CURRENT = def(CURRENT_INPUT);

/** A manifest that starts as a copy of the current definition, edited by `edit`. */
function manifestFrom(edit: (m: any) => void): AppDefinitionStatic {
  const m = structuredClone(CURRENT_INPUT) as any;
  edit(m);
  return def(m);
}

function service(d: AppDefinitionStatic, name: string) {
  const found = d.services.find(s => s.name === name);
  if (!found) throw new Error(`service ${name} missing`);
  return found;
}

describe('applyManifestPolicy', () => {
  it('passes a manifest that only changes allowed fields through unchanged', () => {
    const manifest = manifestFrom(m => {
      const [backend, migrator] = m.services;
      backend.image_suffix = 'api';
      backend.required = false;
      backend.ports = { internal: 4000, external: 8080 };
      backend.health_check = { type: 'tcp', port: 4000, interval: '10s' };
      backend.env_mapping = { DATABASE_URL: 'DB_URL', REDIS_URL: { static: 'redis://cache:6379' } };
      backend.depends_on = [];
      backend.routing.path_prefix = '/v2';
      backend.routing.middlewares = [];
      backend.routing.priority = 50;
      backend.routing.strip_prefix = true;
      migrator.is_init_container = false;
      // Reorder, drop frontend, add a service without protected fields.
      m.services = [migrator, backend, { name: 'worker', image_suffix: 'worker', env_mapping: { QUEUE: 'QUEUE_URL' } }];
      m.env_vars = [{ key: 'OPENAI_API_KEY', sensitive: true }];
      m.manifest = { image_suffix: 'api', path: '/etc/overwatch/app.json' };
    });

    const { next, ignored } = applyManifestPolicy(CURRENT, manifest);

    expect(next).toEqual(manifest);
    expect(ignored).toEqual([]);
  });

  it.each([
    ['admin_access', { enabled: true, secret_env: 'JWT_SECRET' }],
    ['backup', { enabled: false }],
    ['credentials', { db_password_length: 8, jwt_secret_length: 8 }],
    ['db_prefix', 'other_app'],
    ['traefik', { default_middlewares: [] }],
  ])('keeps the current app-level %s and reports the ignored change', (field: string, value: unknown) => {
    const manifest = manifestFrom(m => { m[field] = value; m.env_vars = [{ key: 'NEW_KEY' }]; });

    const { next, ignored } = applyManifestPolicy(CURRENT, manifest);

    expect((next as any)[field]).toEqual((CURRENT as any)[field]);
    expect(ignored).toEqual([field]);
    expect(next.env_vars).toEqual(manifest.env_vars);
  });

  it.each([
    ['user', '0:0'],
    ['command', ['sh', '-c', 'cat /etc/shadow']],
    ['volumes', [
      { name: 'uploads', container_path: '/app/uploads' },
      { name: 'host-root', container_path: '/host', name_template: '/', external: true },
    ]],
    ['networks', ['external']],
    ['backup', { enabled: false }],
  ])('keeps the current per-service %s and reports the ignored change', (field: string, value: unknown) => {
    const manifest = manifestFrom(m => { m.services[0][field] = value; m.services[0].ports = { internal: 4000 }; });

    const { next, ignored } = applyManifestPolicy(CURRENT, manifest);

    expect((service(next, 'backend') as any)[field]).toEqual((service(CURRENT, 'backend') as any)[field]);
    expect(ignored).toEqual([`services.backend.${field}`]);
    expect(service(next, 'backend').ports).toEqual({ internal: 4000 });
  });

  it('keeps routing raw_labels and tls_termination while applying the rest of routing', () => {
    const manifest = manifestFrom(m => {
      m.services[0].routing = {
        path_prefix: '/v2',
        middlewares: [],
        raw_labels: { 'traefik.http.routers.shop.middlewares': 'none@internal' },
        tls_termination: 'upstream',
      };
    });

    const { next, ignored } = applyManifestPolicy(CURRENT, manifest);

    const currentRouting = service(CURRENT, 'backend').routing!;
    expect(service(next, 'backend').routing).toEqual({
      ...service(manifest, 'backend').routing,
      raw_labels: currentRouting.raw_labels,
      tls_termination: currentRouting.tls_termination,
    });
    expect(ignored).toEqual([
      'services.backend.routing.raw_labels',
      'services.backend.routing.tls_termination',
    ]);
  });

  it('keeps protected values the manifest leaves out, without reporting them', () => {
    const manifest = manifestFrom(m => {
      delete m.admin_access; delete m.backup; delete m.credentials; delete m.db_prefix; delete m.traefik;
      const backend = m.services[0];
      delete backend.user; delete backend.command; delete backend.volumes; delete backend.networks; delete backend.backup;
      delete backend.routing;
    });

    const { next, ignored } = applyManifestPolicy(CURRENT, manifest);

    expect(next.admin_access).toEqual(CURRENT.admin_access);
    expect(next.backup).toEqual(CURRENT.backup);
    expect(next.credentials).toEqual(CURRENT.credentials);
    expect(next.db_prefix).toBe(CURRENT.db_prefix);
    expect(next.traefik).toEqual(CURRENT.traefik);
    const currentBackend = service(CURRENT, 'backend');
    const nextBackend = service(next, 'backend');
    expect(nextBackend.user).toBe(currentBackend.user);
    expect(nextBackend.command).toEqual(currentBackend.command);
    expect(nextBackend.volumes).toEqual(currentBackend.volumes);
    expect(nextBackend.networks).toEqual(currentBackend.networks);
    expect(nextBackend.backup).toEqual(currentBackend.backup);
    // Routing itself is the manifest's (path_prefix and middlewares are gone),
    // but the admin's labels and TLS mode survive with schema defaults.
    expect(nextBackend.routing).toEqual({
      enabled: true,
      strip_prefix: false,
      raw_labels: currentBackend.routing!.raw_labels,
      tls_termination: currentBackend.routing!.tls_termination,
    });
    expect(ignored).toEqual([]);
  });

  it('strips protected fields from a service that is new in the manifest', () => {
    const manifest = manifestFrom(m => {
      m.services.push({
        name: 'worker',
        image_suffix: 'worker',
        required: true,
        ports: { internal: 9000 },
        env_mapping: { QUEUE: 'QUEUE_URL' },
        user: '0:0',
        command: ['node', 'worker.js'],
        volumes: [{ name: 'docker-sock', container_path: '/var/run/docker.sock', name_template: '/var/run/docker.sock' }],
        networks: ['external'],
        backup: { enabled: true },
        routing: { path_prefix: '/jobs', raw_labels: { 'traefik.http.routers.x.priority': '999' }, tls_termination: 'upstream' },
      });
    });

    const { next, ignored } = applyManifestPolicy(CURRENT, manifest);

    expect(service(next, 'worker')).toEqual({
      name: 'worker',
      image_suffix: 'worker',
      required: true,
      is_init_container: false,
      ports: { internal: 9000 },
      env_mapping: { QUEUE: 'QUEUE_URL' },
      routing: { enabled: true, strip_prefix: false, path_prefix: '/jobs' },
    });
    expect(ignored).toEqual([
      'services.worker.user',
      'services.worker.command',
      'services.worker.volumes',
      'services.worker.networks',
      'services.worker.backup',
      'services.worker.routing.raw_labels',
      'services.worker.routing.tls_termination',
    ]);
  });

  it('drops every protected field for a new app with no current definition', () => {
    const manifest = CURRENT;

    const { next, ignored } = applyManifestPolicy(null, manifest);

    for (const field of ['admin_access', 'backup', 'credentials', 'db_prefix', 'traefik']) {
      expect(next).not.toHaveProperty(field);
    }
    const backend = service(next, 'backend');
    for (const field of ['user', 'command', 'volumes', 'networks', 'backup']) {
      expect(backend).not.toHaveProperty(field);
    }
    expect(backend.routing).toEqual({ enabled: true, strip_prefix: false, path_prefix: '/api', middlewares: ['api-limit'] });
    expect(service(next, 'migrator')).not.toHaveProperty('command');
    expect(next.services.map(s => s.name)).toEqual(['backend', 'migrator', 'frontend']);
    expect(next.env_vars).toEqual(manifest.env_vars);
    expect(next.manifest).toEqual(manifest.manifest);
    expect(ignored).toEqual([
      'admin_access', 'backup', 'credentials', 'db_prefix', 'traefik',
      'services.backend.user', 'services.backend.command', 'services.backend.volumes',
      'services.backend.networks', 'services.backend.backup',
      'services.backend.routing.raw_labels', 'services.backend.routing.tls_termination',
      'services.migrator.command',
    ]);
  });

  it('does not report protected values that only differ in key order', () => {
    const manifest = manifestFrom(m => {
      const labels = m.services[0].routing.raw_labels;
      m.services[0].routing.raw_labels = Object.fromEntries(Object.entries(labels).reverse());
      m.admin_access = { secret_env: 'AUTH_SERVICE_SECRET', enabled: true };
    });

    expect(applyManifestPolicy(CURRENT, manifest).ignored).toEqual([]);
  });

  it('returns a schema-valid definition and leaves its inputs untouched', () => {
    const current = structuredClone(CURRENT);
    const manifest = manifestFrom(m => {
      m.admin_access = { enabled: false };
      m.services[0].volumes = [];
      m.services[0].routing = { path_prefix: '/v2' };
      delete m.services[1].command;
    });
    const manifestCopy = structuredClone(manifest);

    const { next } = applyManifestPolicy(current, manifest);

    expect(AppDefinitionStaticSchema.parse(next)).toEqual(next);
    expect(current).toEqual(CURRENT);
    expect(manifest).toEqual(manifestCopy);
  });
});

describe('manifestPolicyBaseline', () => {
  const snapshot = def({
    ...CURRENT_INPUT,
    admin_access: { enabled: false },
    services: [
      ...CURRENT_INPUT.services,
      { name: 'legacy-worker', image_suffix: 'worker', command: ['node', 'legacy.js'], volumes: [{ name: 'jobs', container_path: '/jobs' }] },
    ],
  });

  it('uses the tenant snapshot when there is no global definition', () => {
    expect(manifestPolicyBaseline(null, snapshot)).toBe(snapshot);
  });

  it('takes app-level fields and shared services from the global definition', () => {
    const global = def({
      ...CURRENT_INPUT,
      services: [{ ...CURRENT_INPUT.services[0], user: '2000:2000' }],
    });

    const baseline = manifestPolicyBaseline(global, snapshot);

    expect(baseline.admin_access).toEqual(global.admin_access);
    expect(service(baseline, 'backend').user).toBe('2000:2000');
    expect(baseline.services.map(s => s.name)).toEqual(['backend', 'migrator', 'frontend', 'legacy-worker']);
  });

  it('keeps settings of a service only this tenant still runs when its manifest carries it', () => {
    const global = def({ ...CURRENT_INPUT });
    const manifest = manifestFrom(m => {
      m.services.push({ name: 'legacy-worker', image_suffix: 'worker', command: ['node', 'legacy.js'], volumes: [] });
    });

    const { next, ignored } = applyManifestPolicy(manifestPolicyBaseline(global, snapshot), manifest);

    expect(service(next, 'legacy-worker').volumes).toEqual([{ name: 'jobs', container_path: '/jobs' }]);
    expect(service(next, 'legacy-worker').command).toEqual(['node', 'legacy.js']);
    expect(ignored).toEqual(['services.legacy-worker.volumes']);
  });
});
