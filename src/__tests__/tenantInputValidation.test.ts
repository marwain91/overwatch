import { describe, it, expect, afterEach, vi } from 'vitest';

afterEach(() => { vi.resetModules(); });

describe('tenant input validation', () => {
  it('rejects newlines and unsafe characters in image tags', async () => {
    const mod = await import('../services/tenant');
    expect((mod as any).validateImageTag('1.2.3').valid).toBe(true);
    expect((mod as any).validateImageTag('release-2026.05.19').valid).toBe(true);
    expect((mod as any).validateImageTag('latest\nDB_PASSWORD=pwned').valid).toBe(false);
    expect((mod as any).validateImageTag('bad tag').valid).toBe(false);
  });

  it('rejects newlines and malformed tenant domains', async () => {
    const mod = await import('../services/tenant');
    expect((mod as any).validateTenantDomain('acme.example.com').valid).toBe(true);
    expect((mod as any).validateTenantDomain('xn--bcher-kva.example').valid).toBe(true);
    expect((mod as any).validateTenantDomain('acme.example.com\nIMAGE_TAG=pwned').valid).toBe(false);
    expect((mod as any).validateTenantDomain('http://acme.example.com').valid).toBe(false);
  });
});


