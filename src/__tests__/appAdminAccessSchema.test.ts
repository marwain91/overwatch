import { describe, it, expect } from 'vitest';

describe('H3 url_template validation — refuses arbitrary hosts', () => {
  it('accepts default fragment-based template', async () => {
    const { AppAdminAccessSchema } = await import('../models/app');
    const parsed = AppAdminAccessSchema.safeParse({
      enabled: true,
      url_template: 'https://${domain}/admin-login#token=${token}',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts legacy query-based template (starts with https://${domain})', async () => {
    const { AppAdminAccessSchema } = await import('../models/app');
    const parsed = AppAdminAccessSchema.safeParse({
      enabled: true,
      url_template: 'https://${domain}/admin-login?token=${token}',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a template pointing at a non-tenant host (token exfiltration attempt)', async () => {
    const { AppAdminAccessSchema } = await import('../models/app');
    const bad = AppAdminAccessSchema.safeParse({
      enabled: true,
      url_template: 'https://attacker.example/?t=${token}',
    });
    expect(bad.success).toBe(false);
    const metadataAttack = AppAdminAccessSchema.safeParse({
      enabled: true,
      url_template: 'http://169.254.169.254/?t=${token}',
    });
    expect(metadataAttack.success).toBe(false);
  });
});


