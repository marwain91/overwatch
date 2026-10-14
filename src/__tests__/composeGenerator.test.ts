import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { generateComposeFile } from '../services/composeGenerator';

/**
 * The tenant docker-compose.yml is built as data and serialised with js-yaml.
 * These tests parse the generated file and assert its structure, so they hold
 * for any valid formatting — and fail if a field value can change the shape.
 */

function config(): any {
  return {
    project: { name: 'Test', prefix: 'test', db_prefix: 'test' },
    database: {
      type: 'mariadb',
      host: 'db.internal',
      port: 3306,
      root_user: 'root',
      root_password_env: 'MYSQL_ROOT_PASSWORD',
      container_name: 'db',
    },
    networking: {
      external_network: 'test-network',
      internal_network_template: '${prefix}-${tenantId}-internal',
      apps_path: '/app/apps',
    },
    traefik: {
      log_level: 'INFO',
      cert_resolvers: [{ name: 'le-http', challenge: 'http', acme_email: 'ops@example.test', entrypoint: 'web' }],
      middlewares: {
        sec: { type: 'headers', custom_response_headers: { 'X-Frame-Options': 'DENY' }, sts_seconds: 31536000 },
      },
      default_middlewares: ['sec'],
    },
  };
}

function app(services: any[], traefik?: any): any {
  return {
    id: 'shop',
    name: 'Shop',
    domain_template: '*.shop.test',
    registry: { type: 'ghcr', url: 'ghcr.io', repository: 'acme/shop', auth: { type: 'token' } },
    services,
    default_image_tag: '2.1.0',
    traefik,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function render(services: any[], opts: { traefik?: any; tenantTraefik?: any } = {}): string {
  return generateComposeFile({
    app: app(services, opts.traefik),
    tenantId: 't1',
    domain: 't1.shop.test',
    config: config(),
    tenantTraefik: opts.tenantTraefik,
  });
}

function load(yml: string): any {
  return yaml.load(yml);
}

/** Every mapping key anywhere in a parsed document. */
function allKeys(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) allKeys(item, out);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      out.push(k);
      allKeys(v, out);
    }
  }
  return out;
}

const SERVICE_KEYS = [
  'image', 'container_name', 'restart', 'user', 'env_file', 'command', 'environment',
  'volumes', 'networks', 'healthcheck', 'depends_on', 'labels',
];

describe('generateComposeFile structure', () => {
  // One fixture exercising every field the generator renders. The expected
  // document is what the string-built generator (<= v1.x) produced, parsed.
  const services = [
    {
      name: 'migrator', image_suffix: 'backend', required: false, is_init_container: true,
      command: ['npm', 'run', 'migrate'],
      env_mapping: { DATABASE_HOST: 'DB_HOST' },
      networks: ['internal'],
      health_check: { type: 'http', interval: '30s', tool: 'wget' },
    },
    {
      name: 'backend', required: true, is_init_container: false, user: '1000:1000',
      ports: { internal: 3000 },
      env_mapping: {
        DB_HOST: 'DB_HOST',
        DB_PORT: 'DB_PORT',
        FRONTEND_URL: 'FRONTEND_URL',
        BACKEND_URL: 'BACKEND_URL',
        PORT: 'PORT',
        API_PORT: 'BACKEND_PORT',
        NODE_ENV: 'NODE_ENV',
        SMTP_HOST: 'SMTP_HOST',
        FEATURE_FLAG: { static: 'true' },
      },
      volumes: [
        { name: 'uploads', container_path: '/app/uploads', name_template: '${appId}-${tenantId}-uploads' },
        { name: 'shared-cache', container_path: '/cache', external: true },
      ],
      backup: {
        enabled: true,
        paths: [
          { container: '/app/uploads', local: 'uploads' },
          { container: '/app/exports', local: 'exports' },
        ],
      },
      networks: ['external', 'internal'],
      health_check: { type: 'http', path: '/api/health', port: 3001, interval: '15s', start_period: '20s', tool: 'curl' },
      depends_on: ['migrator', 'redis'],
      routing: {
        enabled: true,
        path_prefix: '/api',
        additional_path_prefixes: ['/ws'],
        strip_prefix: true,
        priority: 10,
        middlewares: ['rl', 'auth'],
        raw_labels: {
          'traefik.http.services.shop-t1-backend.loadbalancer.sticky.cookie': 'true',
          'traefik.enable': 'false',
        },
      },
    },
    {
      name: 'frontend', required: true, is_init_container: false,
      ports: { internal: 80 },
      env_mapping: { PORT: 'PORT' },
      health_check: { type: 'http', tool: 'wget' },
      routing: { enabled: true, strip_prefix: false, tls_termination: 'upstream' },
    },
    {
      name: 'redis', image_suffix: 'redis', required: false, is_init_container: false,
      ports: { internal: 6379 },
      routing: { enabled: false, strip_prefix: false },
      health_check: { type: 'tcp', interval: '10s', tool: 'wget' },
      networks: ['internal'],
      volumes: [{ name: 'redis-data', container_path: '/data' }],
    },
    {
      name: 'worker', required: false, is_init_container: false,
      env_mapping: { PORT: 'PORT' },
      volumes: [{ name: 'redis-data', container_path: '/data' }],
      depends_on: ['backend'],
    },
  ];
  const appTraefik = {
    middlewares: {
      rl: { type: 'rateLimit', average: 50, burst: 100, period: '1s' },
      auth: { type: 'chain', middlewares: ['ip'] },
      ip: { type: 'ipAllowList', source_range: ['10.0.0.0/8', '192.168.0.0/16'] },
    },
  };
  const tenantTraefik = {
    host_aliases: ['legacy.shop.test'],
    raw_labels: { frontend: { 'traefik.http.routers.shop-t1-frontend.service': 'shop-t1-frontend' } },
  };

  const ownership = (service: string) => [
    'com.overwatch.managed=true',
    'com.overwatch.app-id=shop',
    'com.overwatch.tenant-id=t1',
    `com.overwatch.service=${service}`,
  ];
  const envFile = ['.env', 'shared.env'];
  const hosts = '(Host(`t1.shop.test`) || Host(`legacy.shop.test`))';

  const expected = {
    services: {
      backend: {
        image: 'ghcr.io/acme/shop/backend:${IMAGE_TAG:-2.1.0}',
        container_name: 'shop-t1-backend',
        restart: 'unless-stopped',
        user: '1000:1000',
        env_file: envFile,
        environment: {
          DB_HOST: 'db.internal',
          DB_PORT: '3306',
          FRONTEND_URL: 'https://t1.shop.test',
          BACKEND_URL: 'https://t1.shop.test',
          PORT: '3000',
          API_PORT: '3000',
          NODE_ENV: 'production',
          SMTP_HOST: '${SMTP_HOST}',
          FEATURE_FLAG: 'true',
        },
        volumes: ['shop-t1-uploads:/app/uploads', 'shared-cache:/cache', 'backend-exports:/app/exports'],
        networks: ['test-network', 'test-t1-internal'],
        healthcheck: {
          test: ['CMD', 'curl', '-f', 'http://127.0.0.1:3001/api/health'],
          interval: '15s',
          timeout: '10s',
          retries: 3,
          start_period: '20s',
        },
        depends_on: {
          migrator: { condition: 'service_completed_successfully' },
          redis: { condition: 'service_started' },
        },
        labels: [
          ...ownership('backend'),
          'traefik.enable=true',
          `traefik.http.routers.shop-t1-backend.rule=${hosts} && (PathPrefix(\`/api\`) || PathPrefix(\`/ws\`))`,
          'traefik.http.routers.shop-t1-backend.entrypoints=websecure',
          'traefik.http.routers.shop-t1-backend.tls=true',
          'traefik.http.routers.shop-t1-backend.tls.certresolver=le-http',
          'traefik.http.routers.shop-t1-backend.priority=10',
          'traefik.http.middlewares.shop-t1-backend-_stripprefix.stripprefix.prefixes=/api,/ws',
          'traefik.http.middlewares.shop-t1-backend-sec.headers.customresponseheaders.X-Frame-Options=DENY',
          'traefik.http.middlewares.shop-t1-backend-sec.headers.stsseconds=31536000',
          'traefik.http.middlewares.shop-t1-backend-rl.ratelimit.average=50',
          'traefik.http.middlewares.shop-t1-backend-rl.ratelimit.burst=100',
          'traefik.http.middlewares.shop-t1-backend-rl.ratelimit.period=1s',
          'traefik.http.middlewares.shop-t1-backend-auth.chain.middlewares=shop-t1-backend-ip@docker',
          'traefik.http.middlewares.shop-t1-backend-ip.ipallowlist.sourcerange=10.0.0.0/8,192.168.0.0/16',
          'traefik.http.routers.shop-t1-backend.middlewares=shop-t1-backend-sec,shop-t1-backend-rl,shop-t1-backend-auth,shop-t1-backend-_stripprefix',
          'traefik.http.services.shop-t1-backend.loadbalancer.server.port=3000',
          'traefik.http.services.shop-t1-backend.loadbalancer.sticky.cookie=true',
        ],
      },
      frontend: {
        image: 'ghcr.io/acme/shop/frontend:${IMAGE_TAG:-2.1.0}',
        container_name: 'shop-t1-frontend',
        restart: 'unless-stopped',
        env_file: envFile,
        environment: { PORT: '80' },
        networks: ['test-network'],
        healthcheck: {
          test: ['CMD', 'wget', '--spider', '-q', 'http://127.0.0.1:80/health'],
          interval: '30s',
          timeout: '10s',
          retries: 3,
        },
        labels: [
          ...ownership('frontend'),
          'traefik.enable=true',
          `traefik.http.routers.shop-t1-frontend.rule=${hosts}`,
          'traefik.http.routers.shop-t1-frontend.entrypoints=web',
          'traefik.http.middlewares.shop-t1-frontend-sec.headers.customresponseheaders.X-Frame-Options=DENY',
          'traefik.http.middlewares.shop-t1-frontend-sec.headers.stsseconds=31536000',
          'traefik.http.routers.shop-t1-frontend.middlewares=shop-t1-frontend-sec',
          'traefik.http.services.shop-t1-frontend.loadbalancer.server.port=80',
          'traefik.http.routers.shop-t1-frontend.service=shop-t1-frontend',
        ],
      },
      redis: {
        image: 'ghcr.io/acme/shop/redis:${IMAGE_TAG:-2.1.0}',
        container_name: 'shop-t1-redis',
        restart: 'unless-stopped',
        env_file: envFile,
        volumes: ['redis-data:/data'],
        networks: ['test-t1-internal'],
        healthcheck: {
          test: ['CMD-SHELL', 'nc -z 127.0.0.1 6379'],
          interval: '10s',
          timeout: '10s',
          retries: 3,
        },
        labels: ownership('redis'),
      },
      worker: {
        image: 'ghcr.io/acme/shop/worker:${IMAGE_TAG:-2.1.0}',
        container_name: 'shop-t1-worker',
        restart: 'unless-stopped',
        env_file: envFile,
        environment: { PORT: '${PORT}' },
        volumes: ['redis-data:/data'],
        networks: ['test-network'],
        depends_on: { backend: { condition: 'service_started' } },
        labels: ownership('worker'),
      },
      migrator: {
        image: 'ghcr.io/acme/shop/backend:${IMAGE_TAG:-2.1.0}',
        container_name: 'shop-t1-migrator',
        restart: 'no',
        env_file: envFile,
        command: ['npm', 'run', 'migrate'],
        environment: { DATABASE_HOST: 'db.internal' },
        networks: ['test-t1-internal'],
        labels: ownership('migrator'),
      },
    },
    networks: {
      'test-network': { external: true },
      'test-t1-internal': null,
    },
    volumes: {
      'shop-t1-uploads': { name: 'shop-t1-uploads' },
      'shared-cache': { external: true },
      'backend-exports': { name: 'backend-exports' },
      'redis-data': { name: 'redis-data' },
    },
  };

  it('renders every field with the same meaning as the string-built generator', () => {
    const doc = load(render(services, { traefik: appTraefik, tenantTraefik }));

    expect(doc).toEqual(expected);
  });

  it('keeps top-level and service ordering: init containers start last', () => {
    const doc = load(render(services, { traefik: appTraefik, tenantTraefik }));

    expect(Object.keys(doc)).toEqual(['services', 'networks', 'volumes']);
    expect(Object.keys(doc.services)).toEqual(['backend', 'frontend', 'redis', 'worker', 'migrator']);
  });

  it('omits the volumes section and the internal network when nothing uses them', () => {
    const doc = load(render([{ name: 'web', required: true, ports: { internal: 8080 } }]));

    expect(doc).not.toHaveProperty('volumes');
    expect(doc.networks).toEqual({ 'test-network': { external: true } });
    expect(doc.services.web).not.toHaveProperty('depends_on');
    expect(doc.services.web).not.toHaveProperty('environment');
  });
});

describe('generateComposeFile treats every value as data', () => {
  it('passes label values with backslashes and quotes to Traefik unchanged', () => {
    const regex = '^https://(.*)\\.example\\.com/(.*)';
    const quoted = 'say \\"hi\\" to "C:\\\\dir\\\\"';
    const doc = load(render(
      [{
        name: 'web', required: true, ports: { internal: 3000 },
        routing: {
          enabled: true, strip_prefix: false, middlewares: ['rx'],
          raw_labels: { 'traefik.http.middlewares.shop-t1-web-q.headers.customrequestheaders.X-Q': quoted },
        },
      }],
      { traefik: { middlewares: { rx: { type: 'redirectRegex', regex, replacement: 'https://example.com/landing' } } } },
    ));

    const labels: string[] = doc.services.web.labels;
    expect(labels).toContain(`traefik.http.middlewares.shop-t1-web-rx.redirectregex.regex=${regex}`);
    expect(labels).toContain(`traefik.http.middlewares.shop-t1-web-q.headers.customrequestheaders.X-Q=${quoted}`);
    expect(Object.keys(doc.services.web)).toEqual(
      ['image', 'container_name', 'restart', 'env_file', 'networks', 'labels'],
    );
  });

  it('escapes $ in the com.overwatch.service label like every other label value', () => {
    const doc = load(render([{ name: 'we$b${X}', required: true }]));
    expect(doc.services['we$b${X}'].labels).toContain('com.overwatch.service=we$$b$${X}');
  });

  it('keeps a service name with quotes or line breaks inside its own key', () => {
    const newline = 'web\n    privileged: true\n  evil:\n    image: attacker/evil';
    const quotes = 'api": {"privileged": true}, "x';
    const doc = load(render([
      { name: newline, required: true },
      { name: quotes, required: true, depends_on: [newline] },
    ]));

    expect(Object.keys(doc.services)).toEqual([newline, quotes]);
    expect(allKeys(doc)).not.toContain('privileged');
    expect(doc.services[newline].container_name).toBe(`shop-t1-${newline}`);
    expect(doc.services[quotes].depends_on).toEqual({ [newline]: { condition: 'service_started' } });
    for (const svc of Object.values<any>(doc.services)) {
      expect(SERVICE_KEYS).toEqual(expect.arrayContaining(Object.keys(svc)));
    }
  });

  it('keeps an env_mapping key with quotes or line breaks as one environment entry', () => {
    // The first key added an INJECTED variable to the string-built file.
    for (const key of ['FOO: "a"\n      INJECTED', 'BAZ": "1", "QUX']) {
      const doc = load(render([{
        name: 'web', required: true,
        env_mapping: { [key]: { static: 'x"\ny: z' }, OTHER: 'SOME_VAR' },
      }]));

      expect(doc.services.web.environment).toEqual({ [key]: 'x"\ny: z', OTHER: '${SOME_VAR}' });
    }
  });

  it('keeps volume names and paths with quotes or line breaks inside their entries', () => {
    // The first path made the string-built service privileged.
    const cases = [
      { name: 'data', containerPath: '/data"\n    privileged: true' },
      { name: 'data\n  evil:\n    driver: local', containerPath: '/data' },
    ];
    for (const { name, containerPath } of cases) {
      const doc = load(render([{
        name: 'web', required: true,
        volumes: [{ name, container_path: containerPath }],
        backup: { enabled: true, paths: [{ container: '/bk"\n    cap_add: [ALL]', local: 'bk' }] },
      }]));

      expect(doc.services.web.volumes).toEqual([
        `${name}:${containerPath}`,
        'web-bk:/bk"\n    cap_add: [ALL]',
      ]);
      expect(Object.keys(doc.volumes)).toEqual([name, 'web-bk']);
      expect(allKeys(doc)).not.toContain('privileged');
      expect(allKeys(doc)).not.toContain('cap_add');
      expect(allKeys(doc)).not.toContain('driver');
    }
  });

  it('keeps health check fields with quotes or line breaks inside the check', () => {
    const hcPath = '/health"]\n      privileged: true';
    const doc = load(render([{
      name: 'web', required: true, ports: { internal: 3000 },
      health_check: { type: 'http', path: hcPath, interval: '30s\n    privileged: true', tool: 'curl' },
    }]));

    expect(doc.services.web.healthcheck.test).toEqual(['CMD', 'curl', '-f', `http://127.0.0.1:3000${hcPath}`]);
    expect(doc.services.web.healthcheck.interval).toBe('30s\n    privileged: true');
    expect(allKeys(doc)).not.toContain('privileged');
  });

  it('keeps strings that look like numbers, booleans or null as strings', () => {
    const lookalikes = ['true', 'no', 'off', 'yes', 'null', '~', '123', '0755', '1e3', '.5', '0x1F', '1000:1000', '2026-01-01'];
    const env = Object.fromEntries(lookalikes.map((v, i) => [`V${i}`, { static: v }]));
    const yml = render([{
      name: 'web', required: true, user: '1000:1000', command: ['sleep', '300', 'true'],
      env_mapping: env,
      health_check: { type: 'tcp', port: 9000, interval: '30s', tool: 'wget' },
    }]);

    const web = load(yml).services.web;
    expect(Object.values(web.environment)).toEqual(lookalikes);
    expect(web.user).toBe('1000:1000');
    expect(web.command).toEqual(['sleep', '300', 'true']);
    expect(web.healthcheck.interval).toBe('30s');
    // js-yaml reads YAML 1.2, but a YAML 1.1 reader takes a plain `no` for
    // false and `1000:1000` for a base-60 number, so those must stay quoted.
    // Either quote style is fine: only "not a plain scalar" matters.
    expect(yml).toMatch(/^\s*user: (["'])1000:1000\1$/m);
    expect(yml).toMatch(/^\s+V1: (["'])no\1$/m);
  });

  it('keeps a key named __proto__ as an ordinary key', () => {
    const doc = load(render([{
      name: 'web', required: true,
      env_mapping: { ['__proto__']: { static: 'x' }, OTHER: 'SOME_VAR' },
    }]));

    expect(Object.keys(doc.services.web.environment)).toEqual(['__proto__', 'OTHER']);
  });

  it('fails loudly on duplicate service names instead of dropping one', () => {
    expect(() => render([
      { name: 'web', required: true, image_suffix: 'one' },
      { name: 'web', required: true, image_suffix: 'two' },
    ])).toThrow(/service 'web'.*more than once/);
  });
});

describe('generated compose file consumers', () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
    vi.resetModules();
    vi.doUnmock('../utils/runDocker');
  });

  it('keeps external volumes discoverable by ensureExternalVolumes', async () => {
    // ensureExternalVolumes scans the file text, not the parsed document.
    const calls: string[][] = [];
    vi.doMock('../utils/runDocker', () => ({
      runDocker: vi.fn(async (_cmd: string, args: string[]) => {
        calls.push(args);
        return { stdout: '', stderr: '' };
      }),
    }));
    const { ensureExternalVolumes } = await import('../services/docker');

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-compose-consumers-'));
    const composePath = path.join(tmpDir, 'docker-compose.yml');
    await fs.writeFile(composePath, render([{
      name: 'web', required: true,
      volumes: [
        { name: 'shared-media', container_path: '/media', external: true },
        { name: 'local-data', container_path: '/data' },
      ],
    }]));
    await ensureExternalVolumes(composePath);

    expect(calls).toContainEqual(['volume', 'inspect', 'shared-media']);
    expect(calls).not.toContainEqual(['volume', 'inspect', 'local-data']);
  });
});

describe('healthcheck durations on stored definitions', () => {
  it('passes valid Compose durations through', () => {
    const web = load(render([{
      name: 'web', required: true, ports: { internal: 3000 },
      health_check: { type: 'http', interval: '1m30s', start_period: '500ms', tool: 'wget' },
    }])).services.web;
    expect(web.healthcheck.interval).toBe('1m30s');
    expect(web.healthcheck.start_period).toBe('500ms');
  });

  it('warns and falls back instead of emitting a duration Compose would reject', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const web = load(render([{
      name: 'web', required: true, ports: { internal: 3000 },
      health_check: { type: 'http', interval: 'soon', start_period: '30', tool: 'wget' },
    }])).services.web;
    expect(web.healthcheck.interval).toBe('30s');
    expect(web.healthcheck).not.toHaveProperty('start_period');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('health_check.interval'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('health_check.start_period'));
    warn.mockRestore();
  });
});
