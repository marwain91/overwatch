import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'http';
import * as net from 'net';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import * as fs from 'fs/promises';
import * as path from 'path';

vi.mock('../services/users', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, isAdminEmail: vi.fn(async () => true) };
});

import { createWebSocketServer, stopWebSocketServer, createUpgradeLimiter } from '../websocket/server';
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

  it('at the global ceiling evicts the oldest unauthenticated socket instead of refusing the new one', async () => {
    await start({ maxPendingPerIp: 10, maxPending: 3 });
    const first = await pending('10.0.0.1');
    for (const ip of ['10.0.0.2', '10.0.0.3']) expect((await pending(ip)).outcome).toBe('open');
    const evicted = closed(first.ws);
    expect((await pending('10.0.0.4')).outcome).toBe('open');
    await evicted;
  });

  it('a legitimate client still authenticates while other addresses hold every pending slot', async () => {
    await start({ maxPendingPerIp: 2, maxPending: 6 });
    for (let i = 1; i <= 6; i++) await pending(`10.0.1.${i}`);
    const admin = await pending('203.0.113.7');
    expect(admin.outcome).toBe('open');
    const authed = new Promise<void>((r) => admin.ws.on('message', (d) => { if (d.toString().includes('auth:ok')) r(); }));
    admin.ws.send(JSON.stringify({ type: 'auth', token: signSession('a@b.c') }));
    await authed;
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

/** A raw client that completes the handshake and then never answers anything, not even a close frame. */
function silentClient(ip: string): Promise<{ sock: net.Socket; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nx-test-ip: ${ip}\r\n\r\n`,
      );
    });
    sock.on('error', () => {});
    const closed = new Promise<number>((r) => sock.on('close', () => r(Date.now())));
    sock.once('data', (d) => (d.toString().startsWith('HTTP/1.1 101') ? resolve({ sock, closed }) : reject(new Error(d.toString()))));
  });
}

function maskedText(text: string): Buffer {
  const payload = Buffer.from(text);
  const mask = Buffer.from([1, 2, 3, 4]);
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))]);
}

describe('websocket refused sockets free their slot at once', () => {
  it('an auth timeout releases the slot immediately and cuts a client that ignores the close frame within a second', async () => {
    await start({ maxPendingPerIp: 1, authTimeoutMs: 100 });
    const silent = await silentClient('10.0.0.1');
    const t0 = Date.now();
    await vi.waitFor(async () => expect((await pending()).outcome).toBe('open'), { timeout: 2_000, interval: 50 });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect((await silent.closed) - t0).toBeLessThan(1_600);
  });

  it('an invalid auth message releases the slot immediately', async () => {
    await start({ maxPendingPerIp: 1 });
    const silent = await silentClient('10.0.0.1');
    silent.sock.write(maskedText('{"type":"auth","token":"nope"}'));
    await vi.waitFor(async () => expect((await pending()).outcome).toBe('open'), { timeout: 1_000, interval: 50 });
    await silent.closed;
  });
});

describe('createUpgradeLimiter', () => {
  it('stays bounded under address churn and still limits an active address', () => {
    const limiter = createUpgradeLimiter({ windowMs: 60_000, max: 2, maxTracked: 100 });
    for (let i = 0; i < 5_000; i++) limiter.allow(`10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`);
    expect(limiter.size()).toBeLessThanOrEqual(100);
    expect(limiter.allow('203.0.113.7')).toBe(true);
    expect(limiter.allow('203.0.113.7')).toBe(true);
    expect(limiter.allow('203.0.113.7')).toBe(false);
  });

  it('drops expired entries first', () => {
    vi.useFakeTimers();
    try {
      const limiter = createUpgradeLimiter({ windowMs: 1_000, max: 1, maxTracked: 10 });
      for (let i = 0; i < 10; i++) limiter.allow(`10.0.0.${i}`);
      vi.advanceTimersByTime(1_500);
      limiter.allow('10.0.1.1');
      expect(limiter.size()).toBe(1);
      expect(limiter.allow('10.0.0.1')).toBe(true); // its window ended
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('src/index.ts WebSocket wiring', () => {
  it('keys the WebSocket limits on the client IP Express would resolve', async () => {
    const src = await fs.readFile(path.join(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain("createWebSocketServer(server, { clientIp: (req) => clientIpOf(req, app.get('trust proxy fn')) });");
  });
});
