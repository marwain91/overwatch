import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import * as fs from 'fs/promises';
import * as path from 'path';

vi.mock('../services/users', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, isAdminEmail: vi.fn(async () => true) };
});

import { createWebSocketServer, stopWebSocketServer } from '../websocket/server';
import { signSession } from '../auth/session';

let server: http.Server;
let port: number;
const open: WebSocket[] = [];

async function start(opts: Parameters<typeof createWebSocketServer>[1]) {
  server = http.createServer();
  createWebSocketServer(server, {
    // Lets one test client stand in for many source addresses.
    clientIp: (req) => String(req.headers['x-test-ip'] ?? req.socket.remoteAddress),
    ...opts,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
}

beforeEach(() => {
  process.env.JWT_SECRET = 'x'.repeat(40);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  for (const ws of open.splice(0)) ws.terminate();
  stopWebSocketServer();
  await new Promise<void>((r) => server.close(() => r()));
  vi.restoreAllMocks();
});

/** Opens a socket that never authenticates. Resolves 'open' or the HTTP status the upgrade was refused with. */
function pending(ip = '10.0.0.1'): Promise<{ ws: WebSocket; outcome: 'open' | number }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { 'x-test-ip': ip } });
  open.push(ws);
  return new Promise((resolve) => {
    ws.on('open', () => resolve({ ws, outcome: 'open' }));
    ws.on('unexpected-response', (_req, res) => { resolve({ ws, outcome: res.statusCode ?? 0 }); res.resume(); });
    ws.on('error', () => resolve({ ws, outcome: -1 }));
  });
}

function closed(ws: WebSocket): Promise<void> {
  return new Promise((r) => { if (ws.readyState === WebSocket.CLOSED) r(); else ws.on('close', () => r()); });
}

describe('websocket pre-auth limits', () => {
  it('caps concurrent unauthenticated sockets per IP and frees a slot when one closes', async () => {
    await start({ maxPendingPerIp: 3 });
    const first = await Promise.all([pending(), pending(), pending()]);
    expect(first.map(p => p.outcome)).toEqual(['open', 'open', 'open']);
    expect((await pending()).outcome).toBe(429);
    expect((await pending('10.0.0.2')).outcome).toBe('open'); // another address is unaffected

    first[0].ws.close();
    await closed(first[0].ws);
    await vi.waitFor(async () => expect((await pending()).outcome).toBe('open'));
  });

  it('caps concurrent unauthenticated sockets globally', async () => {
    await start({ maxPendingPerIp: 10, maxPending: 3 });
    const outcomes = [];
    for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4']) outcomes.push((await pending(ip)).outcome);
    expect(outcomes).toEqual(['open', 'open', 'open', 503]);
  });

  it('an authenticated socket no longer counts as pending', async () => {
    await start({ maxPendingPerIp: 1 });
    const a = await pending();
    expect(a.outcome).toBe('open');
    const authed = new Promise<void>((r) => a.ws.on('message', (d) => { if (d.toString().includes('auth:ok')) r(); }));
    a.ws.send(JSON.stringify({ type: 'auth', token: signSession('a@b.c') }));
    await authed;
    expect((await pending()).outcome).toBe('open');
  });

  it('a socket refused at auth releases its pending slot', async () => {
    await start({ maxPendingPerIp: 1 });
    const a = await pending();
    a.ws.send(JSON.stringify({ type: 'auth', token: 'nope' }));
    await closed(a.ws);
    await vi.waitFor(async () => expect((await pending()).outcome).toBe('open'));
  });

  it('rate-limits upgrades per IP, including ones that closed', async () => {
    await start({ upgradeRate: { windowMs: 60_000, max: 3 } });
    for (let i = 0; i < 3; i++) {
      const p = await pending();
      expect(p.outcome).toBe('open');
      p.ws.close();
      await closed(p.ws);
    }
    expect((await pending()).outcome).toBe(429);
    expect((await pending('10.0.0.2')).outcome).toBe('open');
  });

  it('keeps serving after refusing an upgrade', async () => {
    await start({ maxPendingPerIp: 1 });
    await pending();
    expect((await pending()).outcome).toBe(429);
    expect((await pending('10.0.0.9')).outcome).toBe('open');
  });
});

describe('src/index.ts WebSocket wiring', () => {
  it('keys the WebSocket limits on the client IP Express would resolve', async () => {
    const src = await fs.readFile(path.join(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain("createWebSocketServer(server, { clientIp: (req) => clientIpOf(req, app.get('trust proxy fn')) });");
  });
});
