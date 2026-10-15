import { vi } from 'vitest';

type ReadSnapshot = (appId: string, tenantId: string) => Promise<any>;

/**
 * Factory for `vi.doMock('../services/tenantAppDef', ...)`: snapshot reads and
 * writes are the given mocks, while resolveTenantApp applies the real overlay
 * to the mocked snapshot and the (mocked) global definition, as production does.
 */
export async function tenantAppDefMock(mocks: { readTenantAppDef?: ReadSnapshot; writeTenantAppDef?: (...args: any[]) => Promise<void> }) {
  const actual = await vi.importActual<typeof import('../services/tenantAppDef')>('../services/tenantAppDef');
  const { getApp } = await import('../services/app');
  const readTenantAppDef = mocks.readTenantAppDef ?? vi.fn(async () => null);
  return {
    ...actual,
    readTenantAppDef,
    writeTenantAppDef: mocks.writeTenantAppDef ?? vi.fn(async () => undefined),
    resolveTenantApp: async (appId: string, tenantId: string) => {
      const snapshot = await readTenantAppDef(appId, tenantId);
      return snapshot ? actual.overlayGlobalApp(snapshot, await getApp(appId)) : null;
    },
  };
}
