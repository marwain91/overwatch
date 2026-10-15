import { vi } from 'vitest';
import * as fs from 'fs/promises';

/**
 * The database adapter methods a tenant update uses: it dumps the database
 * before the new version starts and restores that dump if the restart fails.
 * Spread an existing fake adapter over it to keep its own methods.
 */
export function updateDbMethods() {
  return {
    initialize: vi.fn(async () => undefined),
    dumpDatabase: vi.fn(async (_id: string, out: string) => { await fs.writeFile(out, ''); }),
    resetDatabase: vi.fn(async () => undefined),
    restoreDatabase: vi.fn(async () => undefined),
  };
}
