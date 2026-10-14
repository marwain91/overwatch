import type { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';

// Only these look like static files. Client routes may contain dots (tenant
// domains, versions, emails), so an arbitrary extension must still get the app.
const STATIC_EXTENSIONS = new Set([
  '.js', '.mjs', '.css', '.map', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',
  '.webp', '.woff', '.woff2', '.ttf', '.json', '.txt', '.wasm',
]);

/**
 * SPA fallback: serve index.html for client-side routes only. Requests under
 * /assets/ or for a known static-file extension must 404, otherwise a stale
 * hashed chunk (tab left open across an update) would receive HTML and fail to
 * parse as JavaScript.
 */
export function spaFallback(staticPath: string) {
  return (req: Request, res: Response) => {
    const ext = path.extname(req.path).toLowerCase();
    if (req.path.startsWith('/assets/') || STATIC_EXTENSIONS.has(ext)) {
      return res.status(404).type('text/plain').send('Not found');
    }
    const indexPath = path.join(staticPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(404).json({ error: 'Frontend not found' });
    }
  };
}
