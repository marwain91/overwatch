import { describe, it, expect } from 'vitest';
import { buildInfraComposeYml, buildOverwatchComposeYml } from '../services/infraComposeGenerator';
import type { OverwatchConfig } from '../config/schema';
import type { TraefikGlobal } from '../models/traefik';

function makeConfig(traefik: TraefikGlobal): OverwatchConfig {
  return {
    project: { name: 'Test', prefix: 'test' },
    database: { type: 'mariadb', host: 'test-mariadb', port: 3306, root_user: 'root', root_password_env: 'MYSQL_ROOT_PASSWORD', container_name: 'test-mariadb' },
    networking: { external_network: 'test-network', apps_path: '/app/apps' },
    traefik,
  } as OverwatchConfig;
}

describe('buildInfraComposeYml — tls_termination=upstream', () => {
  it('runs without cert_resolvers when tls_termination is upstream', () => {
    const yml = buildInfraComposeYml(makeConfig({
      log_level: 'INFO',
      tls_termination: 'upstream',
      upstream_entrypoint: 'web',
    }));
    expect(yml).toContain('${PROJECT_PREFIX}-traefik');
    expect(yml).not.toContain('traefik-letsencrypt');
    expect(yml).not.toContain('TRAEFIK_CERTIFICATESRESOLVERS');
  });

  it('honors host_port and host_bind on entrypoints', () => {
    const yml = buildInfraComposeYml(makeConfig({
      log_level: 'INFO',
      tls_termination: 'upstream',
      upstream_entrypoint: 'web',
      entrypoints: [{ name: 'web', port: 80, host_port: 8080, host_bind: '127.0.0.1' }],
    }));
    expect(yml).toMatch(/- "?127\.0\.0\.1:8080:80"?$/m);
    expect(yml).not.toMatch(/^\s*- "?80:80"?$/m);
    expect(yml).not.toMatch(/^\s*- "?443:443"?$/m);
  });

  it('emits default 80:80 + 443:443 when entrypoints is omitted (back-compat)', () => {
    const yml = buildInfraComposeYml(makeConfig({
      log_level: 'INFO',
      cert_resolvers: [{ name: 'letsencrypt', challenge: 'http', acme_email: 'a@b.c', entrypoint: 'web' }],
    }));
    expect(yml).toMatch(/- "?80:80"?$/m);
    expect(yml).toMatch(/- "?443:443"?$/m);
  });

  it('uses just host_port:port when host_bind is omitted', () => {
    const yml = buildInfraComposeYml(makeConfig({
      log_level: 'INFO',
      tls_termination: 'upstream',
      entrypoints: [{ name: 'web', port: 80, host_port: 18080 }],
    }));
    expect(yml).toMatch(/- "?18080:80"?$/m);
    expect(yml).not.toMatch(/127\.0\.0\.1/);
  });

  it('throws when neither cert_resolvers nor upstream mode is set', () => {
    expect(() => buildInfraComposeYml(makeConfig({ log_level: 'INFO' })))
      .toThrow(/cert_resolvers OR traefik\.tls_termination/);
  });
});

describe('buildOverwatchComposeYml — env vars and YAML quoting', () => {
  it('emits OVERWATCH_UID/GID without extra inner quotes that Compose rejects', () => {
    const yml = buildOverwatchComposeYml(makeConfig({
      log_level: 'INFO',
      tls_termination: 'upstream',
    }));
    // Acceptable (Compose passes the value unchanged): bare ${VAR} or "${VAR}".
    // BAD: OVERWATCH_UID: "\"${OVERWATCH_UID:-1001}\""  — Compose rejects on YAML parse.
    expect(yml).toMatch(/OVERWATCH_UID:\s+"?\$\{OVERWATCH_UID:-1001\}"?$/m);
    expect(yml).toMatch(/OVERWATCH_GID:\s+"?\$\{OVERWATCH_GID:-1001\}"?$/m);
    expect(yml).not.toMatch(/OVERWATCH_UID:\s+"\\"/);
    expect(yml).not.toMatch(/OVERWATCH_GID:\s+"\\"/);
  });

  it('emits cpus as a number (Compose-compatible), not an over-quoted string', () => {
    const yml = buildOverwatchComposeYml(makeConfig({
      log_level: 'INFO',
      tls_termination: 'upstream',
    }));
    expect(yml).toMatch(/cpus:\s+(1|1\.0)$/m);
    expect(yml).not.toMatch(/cpus:\s+"\\"/);
  });

  it('includes GITHUB_APP_* and GOOGLE_CLIENT_SECRET env passthroughs', () => {
    const yml = buildOverwatchComposeYml(makeConfig({
      log_level: 'INFO',
      tls_termination: 'upstream',
    }));
    expect(yml).toContain('GITHUB_APP_ID: ${GITHUB_APP_ID}');
    expect(yml).toContain('GITHUB_INSTALLATION_ID: ${GITHUB_INSTALLATION_ID}');
    expect(yml).toContain('GITHUB_APP_PRIVATE_KEY: ${GITHUB_APP_PRIVATE_KEY}');
    expect(yml).toContain('GOOGLE_CLIENT_SECRET: ${GOOGLE_CLIENT_SECRET}');
  });
});

describe('buildOverwatchComposeYml — tls_termination=upstream', () => {
  it('emits HTTP-only admin labels (no tls=true, no certresolver) under upstream mode with overwatch block', () => {
    const yml = buildOverwatchComposeYml(makeConfig({
      log_level: 'INFO',
      tls_termination: 'upstream',
      upstream_entrypoint: 'web',
      overwatch: { host: 'admin.example.com' },
    }));
    expect(yml).toMatch(/traefik\.http\.routers\.admin\.entrypoints=web/);
    expect(yml).not.toMatch(/traefik\.http\.routers\.admin\.tls=true/);
    expect(yml).not.toMatch(/certresolver/);
  });

  it('still emits TLS labels in the default (traefik-terminated) mode', () => {
    const yml = buildOverwatchComposeYml(makeConfig({
      log_level: 'INFO',
      cert_resolvers: [{ name: 'letsencrypt', challenge: 'http', acme_email: 'a@b.c', entrypoint: 'web' }],
      overwatch: { host: 'admin.example.com', cert_resolver: 'letsencrypt' },
    }));
    expect(yml).toMatch(/traefik\.http\.routers\.admin\.entrypoints=websecure/);
    expect(yml).toMatch(/traefik\.http\.routers\.admin\.tls=true/);
    expect(yml).toMatch(/certresolver=letsencrypt/);
  });

  it('legacy env-var labels also honor upstream mode when no overwatch block is set', () => {
    const yml = buildOverwatchComposeYml(makeConfig({
      log_level: 'INFO',
      tls_termination: 'upstream',
    }));
    expect(yml).toMatch(/admin\.rule=Host\(`\$\{OVERWATCH_ADMIN_HOST\}`\)/);
    expect(yml).toMatch(/admin\.entrypoints=web/);
    expect(yml).not.toMatch(/admin\.tls=true/);
  });
});
