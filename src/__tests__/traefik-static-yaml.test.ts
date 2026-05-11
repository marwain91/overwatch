import { describe, it, expect } from 'vitest';
import { buildTraefikStaticYml } from '../services/traefikDynamicGenerator';
import type { TraefikGlobal } from '../models/traefik';

describe('buildTraefikStaticYml — certificatesResolvers handling', () => {
  it('omits certificatesResolvers entirely when no resolvers configured (upstream mode)', () => {
    const traefik: TraefikGlobal = {
      log_level: 'INFO',
      tls_termination: 'upstream',
      upstream_entrypoint: 'web',
    };
    const yml = buildTraefikStaticYml(traefik);
    // Traefik v3 rejects an empty certificatesResolvers block as a "standalone element".
    expect(yml).not.toMatch(/^certificatesResolvers:\s*\{\s*\}/m);
    expect(yml).not.toMatch(/^certificatesResolvers:\s*$/m);
  });

  it('emits certificatesResolvers when at least one resolver is configured', () => {
    const traefik: TraefikGlobal = {
      log_level: 'INFO',
      cert_resolvers: [{ name: 'letsencrypt', challenge: 'http', acme_email: 'a@b.c', entrypoint: 'web' }],
    };
    const yml = buildTraefikStaticYml(traefik);
    expect(yml).toMatch(/^certificatesResolvers:/m);
    expect(yml).toMatch(/letsencrypt:/);
  });

  it('emits a single `web` entrypoint when tls_termination=upstream and entrypoints is omitted', () => {
    const traefik: TraefikGlobal = {
      log_level: 'INFO',
      tls_termination: 'upstream',
    };
    const yml = buildTraefikStaticYml(traefik);
    expect(yml).toMatch(/^entryPoints:/m);
    expect(yml).toMatch(/^\s+web:/m);
    expect(yml).not.toMatch(/^\s+websecure:/m);
  });
});
