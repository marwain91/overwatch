import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { spaFallback } from '../middleware/spaFallback';

let dir: string;
let app: express.Express;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'overwatch-spa-'));
  await fs.writeFile(path.join(dir, 'index.html'), '<html>app</html>');
  app = express();
  app.get('/*splat', spaFallback(dir));
});
afterAll(() => fs.rm(dir, { recursive: true, force: true }));

describe('SPA fallback', () => {
  it('serves index.html for client-side routes', async () => {
    const res = await request(app).get('/apps/foo/tenants');
    expect(res.status).toBe(200);
    expect(res.text).toContain('app');
  });

  it('404s missing hashed assets instead of returning HTML', async () => {
    const res = await request(app).get('/assets/Page-abc123.js');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('<html>');
  });

  it('404s other missing files with an extension', async () => {
    expect((await request(app).get('/favicon.ico')).status).toBe(404);
    expect((await request(app).get('/foo.map')).status).toBe(404);
  });

  it('404s every known static-file extension', async () => {
    for (const ext of ['js', 'mjs', 'css', 'map', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'woff', 'woff2', 'ttf', 'json', 'txt', 'wasm']) {
      expect((await request(app).get(`/missing.${ext}`)).status, ext).toBe(404);
    }
  });

  it('serves index.html for client routes that contain dots', async () => {
    for (const url of ['/apps/foo/tenants/acme.example.com', '/tenants/v1.2.3', '/users/john.doe']) {
      const res = await request(app).get(url);
      expect(res.status, url).toBe(200);
      expect(res.text).toContain('app');
    }
  });
});
