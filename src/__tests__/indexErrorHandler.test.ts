import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';

// src/index.ts calls start() on import and exposes no app factory, so the wiring
// is asserted on source (same approach as routeMounting.test.ts).
const INDEX_PATH = path.join(__dirname, '..', 'index.ts');

describe('src/index.ts error handling wiring', () => {
  it('imports the shared errorHandler', async () => {
    const src = await fs.readFile(INDEX_PATH, 'utf-8');
    expect(src).toMatch(/import \{ errorHandler \} from '\.\/middleware\/errorHandler';/);
  });

  it('mounts errorHandler once, after every route and the SPA fallback', async () => {
    const src = await fs.readFile(INDEX_PATH, 'utf-8');
    const mounts = [...src.matchAll(/app\.use\(errorHandler\)/g)];
    expect(mounts).toHaveLength(1);
    const handlerAt = mounts[0].index!;
    for (const marker of ["app.use('/api/traefik'", "app.use('/api/admin-users'", 'app.get(\'/*splat\'']) {
      const at = src.indexOf(marker);
      expect(at, marker).toBeGreaterThan(-1);
      expect(at, marker).toBeLessThan(handlerAt);
    }
  });
});
