import { describe, it, expect } from 'vitest';
import { overlayInfrastructure } from '../services/tenant';
import type { AppDefinition } from '../models/app';

function makeApp(overrides: Partial<AppDefinition> = {}): AppDefinition {
  return {
    id: 'gadgets',
    name: 'Gadgets',
    domain_template: '*.gadgets.app',
    registry: {
      type: 'ghcr',
      url: 'ghcr.io',
      repository: 'marwain91/gadgets',     // OLD repo
      auth: { type: 'token', token_env: 'GHCR_TOKEN' },
    },
    services: [{ name: 'web', required: true, is_init_container: false, ports: { internal: 3000 } }],
    default_image_tag: '1.0.0',           // OLD default
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as AppDefinition;
}

describe('overlayInfrastructure', () => {
  it('replaces registry from global, preserves snapshot services + everything else', () => {
    const snapshot = makeApp({
      // Snapshot has its own services (could be older shape)
      services: [{ name: 'web', required: true, is_init_container: false, ports: { internal: 3000 } } as any],
    });
    const global = makeApp({
      registry: {
        type: 'ghcr',
        url: 'ghcr.io',
        repository: 'TheOpenApps/gadgets',  // NEW repo
        auth: { type: 'token', token_env: 'GHCR_DEPLOY_TOKEN' },
      },
      // Global has additional services that the snapshot doesn't know about
      services: [
        { name: 'web', required: true, is_init_container: false, ports: { internal: 3000 } } as any,
        { name: 'sidecar', required: false, is_init_container: false } as any,
      ],
    });

    const result = overlayInfrastructure(snapshot, global);

    // Registry comes from global (the bug fix)
    expect(result.registry.repository).toBe('TheOpenApps/gadgets');
    expect(result.registry.auth.token_env).toBe('GHCR_DEPLOY_TOKEN');

    // Services come from snapshot (NOT overlaid — schema must stay frozen)
    expect(result.services).toHaveLength(1);
    expect(result.services[0].name).toBe('web');
  });

  it('overlays default_image_tag from global', () => {
    const snapshot = makeApp({ default_image_tag: '1.0.0' });
    const global = makeApp({ default_image_tag: '2.0.0' });
    const result = overlayInfrastructure(snapshot, global);
    expect(result.default_image_tag).toBe('2.0.0');
  });

  it('returns snapshot unchanged when global is null', () => {
    const snapshot = makeApp();
    const result = overlayInfrastructure(snapshot, null);
    expect(result).toEqual(snapshot);
  });

  it('preserves all other top-level fields from snapshot (id, name, domain_template, createdAt, updatedAt)', () => {
    const snapshot = makeApp({ id: 'gadgets', name: 'Gadgets', createdAt: '2025-12-01T00:00:00Z' });
    const global = makeApp({ id: 'gadgets', name: 'Gadgets Renamed', createdAt: '2026-04-28T00:00:00Z' });
    const result = overlayInfrastructure(snapshot, global);
    // Snapshot wins on these
    expect(result.id).toBe('gadgets');
    expect(result.name).toBe('Gadgets'); // snapshot
    expect(result.createdAt).toBe('2025-12-01T00:00:00Z'); // snapshot
  });
});
