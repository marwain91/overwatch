import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

const getApp = vi.fn();
const getTenantInfo = vi.fn();
vi.mock('../services/app', () => ({ getApp: (...a: unknown[]) => getApp(...a) }));
vi.mock('../services/docker', () => ({ getTenantInfo: (...a: unknown[]) => getTenantInfo(...a) }));
vi.mock('../config/loader', () => ({ loadConfig: () => ({ database: {} }) }));

import { mintAdminAccess } from '../services/adminAccess';

function app(adminAccess: Record<string, unknown> | undefined) {
  return { id: 'demo', name: 'demo', admin_access: adminAccess };
}

beforeEach(() => {
  getApp.mockReset();
  getTenantInfo.mockReset();
  getTenantInfo.mockResolvedValue({ appId: 'demo', tenantId: 't1', domain: 't1.example.com', version: '1' });
  process.env.AUTH_SERVICE_SECRET = 'test-secret';
});

describe('mintAdminAccess', () => {
  it('replaces every placeholder occurrence and signs the token', async () => {
    getApp.mockResolvedValue(app({
      enabled: true,
      url_template: 'https://${domain}/login?host=${domain}&t=${token}&t2=${token}&id=${tenantId}',
    }));
    const { accessUrl, token } = await mintAdminAccess('demo', 't1');
    expect(accessUrl).not.toContain('${');
    expect(accessUrl).toBe(
      `https://t1.example.com/login?host=t1.example.com&t=${encodeURIComponent(token)}&t2=${encodeURIComponent(token)}&id=t1`,
    );
    const payload = jwt.verify(token, 'test-secret') as Record<string, unknown>;
    expect(payload.isSystemAdmin).toBe(true);
    expect(payload.tenantId).toBe('t1');
  });

  it('refuses a template that is not pinned to https://${domain}', async () => {
    getApp.mockResolvedValue(app({ enabled: true, url_template: 'https://evil.example/x#${token}' }));
    await expect(mintAdminAccess('demo', 't1')).rejects.toMatchObject({ status: 500 });
  });

  it('refuses when admin access is disabled', async () => {
    getApp.mockResolvedValue(app({ enabled: false }));
    await expect(mintAdminAccess('demo', 't1')).rejects.toMatchObject({ status: 400 });
  });

  it('refuses a reserved secret_env without reading it', async () => {
    process.env.JWT_SECRET = 'core';
    getApp.mockResolvedValue(app({ enabled: true, secret_env: 'JWT_SECRET' }));
    await expect(mintAdminAccess('demo', 't1')).rejects.toMatchObject({ status: 400 });
  });

  it('404s for a missing app or tenant', async () => {
    getApp.mockResolvedValue(null);
    await expect(mintAdminAccess('demo', 't1')).rejects.toMatchObject({ status: 404 });
    getApp.mockResolvedValue(app({ enabled: true }));
    getTenantInfo.mockResolvedValue(null);
    await expect(mintAdminAccess('demo', 't1')).rejects.toMatchObject({ status: 404 });
  });
});
