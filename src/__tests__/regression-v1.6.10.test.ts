import { describe, it, expect } from "vitest";
import { buildInfraComposeYml, buildOverwatchComposeYml } from "/app/src/services/infraComposeGenerator";
import type { OverwatchConfig } from "/app/src/config/schema";

// Mimic an existing production deploy (daktela-vms.diteco.eu).
const existingConfig: OverwatchConfig = {
  project: { name: "Daktela", prefix: "daktela", db_prefix: "" },
  database: { type: "mariadb", host: "daktela-mariadb", port: 3306, root_user: "root", root_password_env: "MYSQL_ROOT_PASSWORD", container_name: "daktela-mariadb" },
  networking: { external_network: "daktela-network", apps_path: "/app/apps" },
  traefik: {
    log_level: "INFO",
    cert_resolvers: [
      { name: "letsencrypt-cf", challenge: "dns", provider: "cloudflare", acme_email: "jirka@havliczech.eu", env: { CF_DNS_API_TOKEN: "${CF_DNS_API_TOKEN}" }, domain_patterns: ["*.kwoutr.io"] },
      { name: "letsencrypt", challenge: "http", acme_email: "jirka@havliczech.eu", entrypoint: "web" },
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
    expect(yml).toContain("TRAEFIK_CERTIFICATESRESOLVERS_LETSENCRYPT_CF_ACME_EMAIL=jirka@havliczech.eu");
    expect(yml).toContain("TRAEFIK_CERTIFICATESRESOLVERS_LETSENCRYPT_ACME_EMAIL=jirka@havliczech.eu");
    expect(yml).toContain("CF_DNS_API_TOKEN=${CF_DNS_API_TOKEN}");
  });

  it("overwatch admin still emits websecure/tls=true under default tls_termination", () => {
    const yml = buildOverwatchComposeYml(existingConfig);
    expect(yml).toMatch(/admin\.entrypoints=websecure/);
    expect(yml).toMatch(/admin\.tls=true/);
  });
});
