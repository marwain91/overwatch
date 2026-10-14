import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import * as path from 'path';
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

  it('drops the removed GITHUB_APP_* and unread GOOGLE_CLIENT_SECRET passthroughs', () => {
    const yml = buildOverwatchComposeYml(makeConfig({ log_level: 'INFO', tls_termination: 'upstream' }));
    expect(yml).not.toContain('GITHUB_');
    expect(yml).not.toContain('GOOGLE_CLIENT_SECRET');
  });

  it('passes ALLOWED_ADMIN_EMAILS through (the first admin cannot sign in without it)', () => {
    const yml = buildOverwatchComposeYml(makeConfig({ log_level: 'INFO', tls_termination: 'upstream' }));
    expect(yml).toContain('ALLOWED_ADMIN_EMAILS');
  });

  it('defaults OVERWATCH_TRUST_PROXY to the same value as the static template', () => {
    const yml = buildOverwatchComposeYml(makeConfig({ log_level: 'INFO', tls_termination: 'upstream' }));
    expect(yml).toMatch(/OVERWATCH_TRUST_PROXY:\s+"?\$\{OVERWATCH_TRUST_PROXY:-1\}"?$/m);
    const tpl = readFileSync(path.resolve(__dirname, '..', '..', 'templates', 'overwatch', 'docker-compose.yml'), 'utf-8');
    expect(tpl).toContain('${OVERWATCH_TRUST_PROXY:-1}');
  });

  it('mounts overwatch.yaml read-write', () => {
    const yml = buildOverwatchComposeYml(makeConfig({ log_level: 'INFO', tls_termination: 'upstream' }));
    expect(yml).toContain('./overwatch.yaml:/app/overwatch.yaml\n');
    expect(yml).not.toContain('overwatch.yaml:/app/overwatch.yaml:ro');
  });

  it('R2_ENDPOINT defaults from R2_ACCOUNT_ID but can be overridden by .env', () => {
    // Important for jurisdictional R2 buckets (.eu, .fedramp) where the default
    // construction does not produce the right URL.
    const yml = buildOverwatchComposeYml(makeConfig({
      log_level: 'INFO',
      tls_termination: 'upstream',
    }));
    expect(yml).toContain('R2_ENDPOINT: ${R2_ENDPOINT:-https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com}');
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

describe('buildInfraComposeYml — database engine', () => {
  const http = { log_level: 'INFO', cert_resolvers: [{ name: 'le', challenge: 'http', acme_email: 'a@b.c', entrypoint: 'web' }] } as TraefikGlobal;

  it('pins MariaDB 10.11 and Traefik v3.6 (the reference versions)', () => {
    const yml = buildInfraComposeYml(makeConfig(http));
    expect(yml).toContain('image: mariadb:10.11');
    expect(yml).toContain('image: traefik:v3.6');
    expect(yml).toContain('traefik-letsencrypt:/letsencrypt');
  });

  it('emits a postgres service, volume and password env for database.type=postgres', () => {
    const cfg = makeConfig(http);
    cfg.database.type = 'postgres';
    const yml = buildInfraComposeYml(cfg);
    expect(yml).toContain('image: postgres:16');
    expect(yml).toContain('postgres-data:/var/lib/postgresql/data');
    expect(yml).toContain('POSTGRES_PASSWORD');
    expect(yml).not.toContain('mariadb');
    const ow = buildOverwatchComposeYml(cfg);
    expect(ow).toContain('POSTGRES_PASSWORD');
    expect(ow).not.toContain('MYSQL_ROOT_PASSWORD');
  });
});

describe('overwatch service env_file', () => {
  const entry = /env_file:\s*\n\s*- path: \.env\s*\n\s*required: false/;

  it('generator passes the whole .env through as an optional env_file', () => {
    const yml = buildOverwatchComposeYml(makeConfig({ log_level: 'INFO', tls_termination: 'upstream' }));
    expect(yml).toMatch(entry);
    expect(yml).toContain('OVERWATCH_TRUST_PROXY');
  });

  it('static template has the same env_file entry', () => {
    const tpl = readFileSync(path.resolve(__dirname, '..', '..', 'templates', 'overwatch', 'docker-compose.yml'), 'utf-8');
    expect(tpl).toMatch(entry);
  });
});

// Mimic an existing production deploy (daktela-vms.diteco.eu).
const existingConfig: OverwatchConfig = {
  project: { name: "Daktela", prefix: "daktela", db_prefix: "" },
  database: { type: "mariadb", host: "daktela-mariadb", port: 3306, root_user: "root", root_password_env: "MYSQL_ROOT_PASSWORD", container_name: "daktela-mariadb" },
  networking: { external_network: "daktela-network", apps_path: "/app/apps" },
  traefik: {
    log_level: "INFO",
    cert_resolvers: [
      { name: "letsencrypt-cf", challenge: "dns", provider: "cloudflare", acme_email: "admin@example.com", env: { CF_DNS_API_TOKEN: "${CF_DNS_API_TOKEN}" }, domain_patterns: ["*.acme.io"] },
      { name: "letsencrypt", challenge: "http", acme_email: "admin@example.com", entrypoint: "web" },
    ],
  },
} as any;

describe("v1.6.10 regression: existing prod configs produce v1.6.9-style output", () => {
  it("emits the legacy 80:80 / 443:443 ports list", () => {
    const yml = buildInfraComposeYml(existingConfig);
    expect(yml).toMatch(/- "?80:80"?$/m);
    expect(yml).toMatch(/- "?443:443"?$/m);
    expect(yml).toContain("traefik-letsencrypt:/letsencrypt");
    expect(yml).toContain("traefik-letsencrypt: null");
  });

  it("emits the cert-resolver ACME_EMAIL env vars", () => {
    const yml = buildInfraComposeYml(existingConfig);
    expect(yml).toContain("TRAEFIK_CERTIFICATESRESOLVERS_LETSENCRYPT_CF_ACME_EMAIL=admin@example.com");
    expect(yml).toContain("TRAEFIK_CERTIFICATESRESOLVERS_LETSENCRYPT_ACME_EMAIL=admin@example.com");
    expect(yml).toContain("CF_DNS_API_TOKEN=${CF_DNS_API_TOKEN}");
  });

  it("overwatch admin still emits websecure/tls=true under default tls_termination", () => {
    const yml = buildOverwatchComposeYml(existingConfig);
    expect(yml).toMatch(/admin\.entrypoints=websecure/);
    expect(yml).toMatch(/admin\.tls=true/);
  });
});
