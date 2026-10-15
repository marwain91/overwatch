import { describe, it, expect } from 'vitest';
import * as yaml from 'js-yaml';
import { generateComposeFile } from '../services/composeGenerator';

function config(): any {
  return {
    project: { name: 'Test', prefix: 'test', db_prefix: 'test' },
    database: { type: 'mariadb', host: 'db.internal', port: 3306, root_user: 'root', root_password_env: 'MYSQL_ROOT_PASSWORD', container_name: 'db' },
    networking: { external_network: 'test-network', internal_network_template: '${prefix}-${tenantId}-internal', apps_path: '/app/apps' },
    traefik: {
      log_level: 'INFO',
      cert_resolvers: [{ name: 'le-http', challenge: 'http', acme_email: 'ops@example.test', entrypoint: 'web' }],
      middlewares: {},
      default_middlewares: [],
    },
  };
}

function render(services: any[], traefik?: any): any {
  const yml = generateComposeFile({
    app: {
      id: 'shop', name: 'Shop', domain_template: '*.shop.test',
      registry: { type: 'ghcr', url: 'ghcr.io', repository: 'acme/shop', auth: { type: 'token' } },
      services, default_image_tag: '2.1.0', traefik,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    } as any,
    tenantId: 't1', domain: 't1.shop.test', config: config(),
  });
  return yaml.load(yml);
}

const web = (extra: any = {}) => ({
  name: 'web', required: true, is_init_container: false, ports: { internal: 3000 },
  routing: { enabled: true }, ...extra,
});

describe('compose label escaping', () => {
  it('writes $ in label values as $$ so compose hands Traefik the literal text', () => {
    const doc = render([web({
      routing: { enabled: true, raw_labels: { 'traefik.http.middlewares.shop-t1-web-x.replacepathregex.replacement': '/new/$1' } },
    })]);
    expect(doc.services.web.labels).toContain('traefik.http.middlewares.shop-t1-web-x.replacepathregex.replacement=/new/$$1');
  });

  it('keeps an $apr1$ basicauth hash intact', () => {
    const doc = render([web()], {
      middlewares: { auth: { type: 'basicAuth', users: ['admin:$apr1$H6uskkkW$IgXLP6ewTrSuBkTrqE8wj/'] } },
      default_middlewares: ['auth'],
    });
    const label = doc.services.web.labels.find((l: string) => l.includes('basicauth.users'));
    expect(label).toContain('admin:$$apr1$$H6uskkkW$$IgXLP6ewTrSuBkTrqE8wj/');
  });

  it('treats an already-doubled basicauth hash as the same hash', () => {
    const doc = render([web()], {
      middlewares: { auth: { type: 'basicAuth', users: ['admin:$$apr1$$H6uskkkW$$IgXLP6ewTrSuBkTrqE8wj/'] } },
      default_middlewares: ['auth'],
    });
    const label = doc.services.web.labels.find((l: string) => l.includes('basicauth.users'));
    expect(label).toContain('admin:$$apr1$$H6uskkkW$$IgXLP6ewTrSuBkTrqE8wj/');
    expect(label).not.toContain('$$$$');
  });
});

describe('compose environment values', () => {
  it('keeps a static value containing ${X} literal', () => {
    const doc = render([web({ env_mapping: { GREETING: { static: 'hi ${X} and $Y' } } })]);
    expect(doc.services.web.environment.GREETING).toBe('hi $${X} and $$Y');
  });

  it('still lets a named source be interpolated by compose', () => {
    const doc = render([web({ env_mapping: { API_KEY: 'THIRD_PARTY_KEY' } })]);
    expect(doc.services.web.environment.API_KEY).toBe('${THIRD_PARTY_KEY}');
  });
});

describe('backup volumes', () => {
  it('declares the volume a service mounts for a backup path another service already covers', () => {
    const doc = render([
      web({ volumes: [{ name: 'uploads', container_path: '/data' }] }),
      { name: 'worker', required: false, is_init_container: false,
        backup: { enabled: true, paths: [{ local: 'data', container: '/data' }] } },
    ]);
    // Tenant-scoped: an unscoped `worker-data` was shared by every tenant.
    expect(doc.services.worker.volumes).toEqual(['shop-t1-worker-data:/data']);
    expect(Object.keys(doc.volumes)).toContain('shop-t1-worker-data');
  });

  it('declares every named volume any service mounts', () => {
    const doc = render([
      web({ volumes: [{ name: 'uploads', container_path: '/data' }],
        backup: { enabled: true, paths: [{ local: 'data', container: '/data' }, { local: 'cache', container: '/cache' }] } }),
      { name: 'worker', required: false, is_init_container: false,
        backup: { enabled: true, paths: [{ local: 'data', container: '/data' }] } },
    ]);
    const mounted = Object.values<any>(doc.services).flatMap(s => s.volumes ?? []).map((v: string) => v.split(':')[0]);
    for (const name of mounted) expect(doc.volumes).toHaveProperty([name]);
  });
});
