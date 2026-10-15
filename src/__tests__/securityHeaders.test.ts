import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { securityHeaders } from '../middleware/securityHeaders';

function appWith(trust: unknown) {
  const app = express();
  app.set('trust proxy', trust);
  app.use(securityHeaders);
  app.get('/', (_req, res) => { res.json({}); });
  return app;
}

function directive(csp: string, name: string): string[] {
  const d = csp.split(';').map(s => s.trim()).find(s => s.startsWith(`${name} `));
  return d ? d.split(/\s+/).slice(1) : [];
}

describe('securityHeaders', () => {
  it("pins connect-src to 'self' (no wildcard wss:)", async () => {
    const res = await request(appWith(false)).get('/');
    const connect = directive(res.headers['content-security-policy'], 'connect-src');
    expect(connect).toContain("'self'");
    expect(connect).not.toContain('wss:');
    expect(connect).not.toContain('ws:');
    expect(directive(res.headers['content-security-policy'], 'script-src')).not.toContain("'unsafe-inline'");
  });

  it('sends HSTS for one year on a request that arrived over HTTPS at the proxy', async () => {
    const res = await request(appWith(() => true)).get('/').set('X-Forwarded-Proto', 'https');
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000');
  });

  it('sends no HSTS over plain HTTP, or when the proto header comes from an untrusted peer', async () => {
    expect((await request(appWith(() => true)).get('/')).headers['strict-transport-security']).toBeUndefined();
    const spoofed = await request(appWith(false)).get('/').set('X-Forwarded-Proto', 'https');
    expect(spoofed.headers['strict-transport-security']).toBeUndefined();
  });

  it('keeps the other headers', async () => {
    const res = await request(appWith(false)).get('/');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('src/index.ts mounts it', async () => {
    const src = await fs.readFile(path.join(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('app.use(securityHeaders);');
    expect(src).not.toContain('Content-Security-Policy');
  });
});

describe('ui/index.html under the CSP', () => {
  const ui = path.join(__dirname, '..', '..', 'ui');

  it('has no inline script: the theme bootstrap is a static file', async () => {
    const html = await fs.readFile(path.join(ui, 'index.html'), 'utf-8');
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attrs, body] of scripts) {
      expect(attrs).toMatch(/\bsrc=/);
      expect(body.trim()).toBe('');
    }
    expect(html).toContain('<script src="/theme-init.js"></script>');
    const init = await fs.readFile(path.join(ui, 'public', 'theme-init.js'), 'utf-8');
    expect(init).toContain("localStorage.getItem('overwatch_theme')");
  });

  it('opens the WebSocket on the page origin, which connect-src self covers', async () => {
    const ws = await fs.readFile(path.join(ui, 'src', 'stores', 'wsStore.ts'), 'utf-8');
    expect(ws).toContain('`${protocol}//${location.host}/ws`');
  });
});
