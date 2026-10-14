import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const restoreApp = vi.fn();
const purgeApp = vi.fn();
const writeAuditEntry = vi.fn();

vi.mock('../services/app', () => ({
  applyApp: vi.fn(),
  restoreApp: (...a: unknown[]) => restoreApp(...a),
  purgeApp: (...a: unknown[]) => purgeApp(...a),
}));
vi.mock('../services/auditLog', () => ({
  writeAuditEntry: (...a: unknown[]) => writeAuditEntry(...a),
  flushAuditLog: async () => {},
}));

import { runApps } from '../cli/apps';

class ExitError extends Error {
  constructor(public code: number) { super(`exit ${code}`); }
}

let errors: string[];
let logs: string[];

beforeEach(() => {
  restoreApp.mockReset().mockResolvedValue({ id: 'shop' });
  purgeApp.mockReset().mockResolvedValue(undefined);
  writeAuditEntry.mockReset();
  errors = [];
  logs = [];
  vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.join(' ')); });
  vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')); });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new ExitError(code ?? 0); }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('overwatch apps restore', () => {
  it('restores the trashed app and audits it', async () => {
    await runApps(['restore', 'shop']);
    expect(restoreApp).toHaveBeenCalledWith('shop');
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ action: 'apps.restore shop', method: 'CLI' }));
  });

  it('exits 2 with usage when the id is missing', async () => {
    await expect(runApps(['restore'])).rejects.toMatchObject({ code: 2 });
    expect(restoreApp).not.toHaveBeenCalled();
  });

  it('exits 2 and reports the service error', async () => {
    restoreApp.mockRejectedValue(new Error("No trashed app with id 'shop' to restore"));
    await expect(runApps(['restore', 'shop'])).rejects.toMatchObject({ code: 2 });
    expect(errors.join('\n')).toContain('No trashed app');
  });
});

describe('overwatch apps purge', () => {
  it('refuses to purge without --yes when stdin is not a terminal', async () => {
    await expect(runApps(['purge', 'shop'])).rejects.toMatchObject({ code: 2 });
    expect(purgeApp).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('--yes');
  });

  it('purges and audits with --yes', async () => {
    await runApps(['purge', 'shop', '--yes']);
    expect(purgeApp).toHaveBeenCalledWith('shop');
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ action: 'apps.purge shop', method: 'CLI' }));
  });

  it('exits 2 with usage when the id is missing', async () => {
    await expect(runApps(['purge', '--yes'])).rejects.toMatchObject({ code: 2 });
    expect(purgeApp).not.toHaveBeenCalled();
  });
});
