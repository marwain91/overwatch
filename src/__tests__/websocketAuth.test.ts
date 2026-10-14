import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'http';
import * as net from 'net';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import jwt from 'jsonwebtoken';

const members = new Set<string>();
vi.mock('../services/users', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, isAdminEmail: vi.fn(async (e: string) => members.has(e)) };
});

import { isAdminEmail } from '../services/users';
import { createWebSocketServer, stopWebSocketServer } from '../websocket/server';
import { signSession, SESSION_AUDIENCE, SESSION_ISSUER } from '../auth/session';

let server: http.Server;
let port: number;
let wss: ReturnType<typeof createWebSocketServer>;

beforeEach(async () => {
  process.env.JWT_SECRET = 'x'.repeat(40);
  members.clear();
  vi.mocked(isAdminEmail).mockImplementation(async (e: string) => members.has(e));
  members.add('a@b.c');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  server = http.createServer();
  wss = createWebSocketServer(server, { membershipRecheckMs: 50, membershipReadTimeoutMs: 100 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  stopWebSocketServer();
  await new Promise<void>((r) => server.close(() => r()));
  vi.restoreAllMocks();
});

interface Client { ws: WebSocket; closed: Promise<{ code: number; reason: string }>; messages: string[] }

function connect(token: string): Client {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages: string[] = [];
  ws.on('message', (d) => messages.push(d.toString()));
  ws.on('error', () => {});
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
  return { ws, closed, messages };
}

const authed = (c: Client) => vi.waitFor(() => expect(c.messages.join()).toContain('auth:ok'));

describe('websocket auth', () => {
  it('accepts a valid session for a current admin user', async () => {
    const c = connect(signSession('a@b.c'));
    await authed(c);
    c.ws.close();
  });

  it('rejects a token without the web audience', async () => {
    const legacy = jwt.sign({ email: 'a@b.c' }, process.env.JWT_SECRET!, { expiresIn: '1h' });
    const c = connect(legacy);
    expect((await c.closed).code).toBe(4003);
  });

  it('rejects a valid session whose user is not an admin user', async () => {
    const c = connect(signSession('nobody@b.c'));
    expect((await c.closed).code).toBe(4003);
  });

  it('closes the socket when the token expires', async () => {
    const short = jwt.sign({ email: 'a@b.c' }, process.env.JWT_SECRET!, {
      expiresIn: 1, audience: SESSION_AUDIENCE, issuer: SESSION_ISSUER,
    });
    const c = connect(short);
    await authed(c);
    const { code } = await c.closed;
    expect(code).toBe(4401);
  });

  it('closes the socket when the user is removed from admin users', async () => {
    const c = connect(signSession('a@b.c'));
    await authed(c);
    members.delete('a@b.c');
    const { code } = await c.closed;
    expect(code).toBe(4403);
  });

  it('keeps sockets of users that are still admins', async () => {
    members.add('b@b.c');
    const keep = connect(signSession('a@b.c'));
    const drop = connect(signSession('b@b.c'));
    await authed(keep); await authed(drop);
    members.delete('b@b.c');
    await drop.closed;
    expect(keep.ws.readyState).toBe(WebSocket.OPEN);
    keep.ws.close();
  });
});

describe('websocket membership re-check scheduling', () => {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  it('never runs two re-checks at once when the store is slower than the interval', async () => {
    const c = connect(signSession('a@b.c'));
    await authed(c);
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    vi.mocked(isAdminEmail).mockImplementation(async (e: string) => {
      calls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(80); // longer than the 50 ms interval, shorter than the 100 ms read timeout
      inFlight--;
      return members.has(e);
    });
    await sleep(700);
    expect(calls).toBeGreaterThan(1);
    expect(maxInFlight).toBe(1);
    c.ws.close();
  });

  it('a store read that never settles is cut off, the socket is kept and re-checks resume', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = connect(signSession('a@b.c'));
    await authed(c);
    vi.mocked(isAdminEmail).mockImplementation(() => new Promise<boolean>(() => {}));
    await vi.waitFor(() => expect(warn.mock.calls.join()).toMatch(/timed out/));
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    members.delete('a@b.c');
    vi.mocked(isAdminEmail).mockImplementation(async (e: string) => members.has(e));
    expect((await c.closed).code).toBe(4403);
  });

  it('keeps the socket when the store read fails, and still revokes once it recovers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = connect(signSession('a@b.c'));
    await authed(c);
    vi.mocked(isAdminEmail).mockRejectedValue(new Error('disk'));
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    await sleep(150);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    members.delete('a@b.c');
    vi.mocked(isAdminEmail).mockImplementation(async (e: string) => members.has(e));
    expect((await c.closed).code).toBe(4403);
  });
});

describe('websocket per-user connection count', () => {
  it('does not double-decrement when error and close both fire for one socket', async () => {
    const serverSide: WebSocket[] = [];
    wss.on('connection', (s) => serverSide.push(s));

    const token = signSession('a@b.c');
    const first = connect(token);
    const second = connect(token);
    await authed(first); await authed(second);

    // 'error' then 'close' on the same server-side socket
    serverSide[0].emit('error', new Error('boom'));
    serverSide[0].terminate();
    await first.closed;

    // second still holds 1 slot, so exactly 4 more fit (limit 5)
    const more = Array.from({ length: 4 }, () => connect(token));
    await Promise.all(more.map(authed));
    const overflow = connect(token);
    expect((await overflow.closed).code).toBe(4029);
    for (const c of [second, ...more]) c.ws.close();
  });

  it('frees a slot when a socket closes', async () => {
    const token = signSession('a@b.c');
    const five = Array.from({ length: 5 }, () => connect(token));
    await Promise.all(five.map(authed));
    expect((await connect(token).closed).code).toBe(4029);
    five[0].ws.close();
    await five[0].closed;
    const again = connect(token);
    await authed(again);
    for (const c of [...five.slice(1), again]) c.ws.close();
  });
});

describe('websocket hostile input before auth', () => {
  /** Sends a raw upgrade request; resolves with the first reply chunk ('' if the server just hangs up). */
  function rawUpgrade(target: string, host: string): Promise<string> {
    return new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(
          `GET ${target} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      sock.on('data', (d) => { resolve(d.toString()); sock.destroy(); });
      sock.on('error', () => {});
      sock.on('close', () => resolve(''));
    });
  }

  it('survives an upgrade whose Host header is not a valid URL host', async () => {
    await rawUpgrade('/ws', '127.0.0.1:x');
    const c = connect(signSession('a@b.c'));
    await authed(c);
    c.ws.close();
  });

  it('drops an upgrade whose request target does not parse, and keeps serving', async () => {
    expect(await rawUpgrade('//', '127.0.0.1')).toBe('');
    const c = connect(signSession('a@b.c'));
    await authed(c);
    c.ws.close();
  });

  it('closes a socket whose first frame exceeds the payload limit and keeps serving', async () => {
    const big = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    big.on('error', () => {});
    const closed = new Promise<number>((resolve) => big.on('close', (code) => resolve(code)));
    big.on('open', () => big.send('x'.repeat(16 * 1024)));
    expect(await closed).toBe(1009);
    const c = connect(signSession('a@b.c'));
    await authed(c);
    c.ws.close();
  });
});
