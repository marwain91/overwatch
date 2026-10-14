import { describe, it, expect, vi } from 'vitest';

const listApps = vi.fn();
vi.mock('../services/app', () => ({ listApps: (...a: unknown[]) => listApps(...a) }));
vi.mock('../services/docker', () => ({ listTenants: vi.fn(), getTenantInfo: vi.fn() }));

import { listAppsHandler } from '../mcp/tools/read';
import { NotFoundError, HttpError } from '../utils/httpErrors';

const viewer = { email: 'a@b.c', role: 'viewer' as const };

describe('MCP tools map HttpError', () => {
  it('returns the message of an exposed HttpError', async () => {
    listApps.mockRejectedValueOnce(new NotFoundError("App 'x' not found"));
    const r = await listAppsHandler({}, viewer);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("App 'x' not found");
  });

  it('keeps the generic message for unexpected and non-exposed errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    listApps.mockRejectedValueOnce(new Error("ENOENT: open '/srv/data/apps.json'"));
    const r1 = await listAppsHandler({}, viewer);
    expect(r1.content[0].text).toBe('Failed to list apps');
    listApps.mockRejectedValueOnce(new HttpError(500, 'internal detail'));
    const r2 = await listAppsHandler({}, viewer);
    expect(r2.content[0].text).toBe('Failed to list apps');
  });
});
