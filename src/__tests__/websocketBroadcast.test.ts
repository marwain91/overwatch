import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';

vi.mock('../services/users', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, isAdminEmail: vi.fn(async () => true) };
});

import { createWebSocketServer, stopWebSocketServer } from '../websocket/server';
import { signSession } from '../auth/session';
import { eventBus } from '../services/eventBus';
import { containerEvent } from './eventFixtures';

const MB = 1024 * 1024;

let server: http.Server;
let serverSide: WebSocket;
let client: WebSocket;
let buffered = 0;
let sendSpy: ReturnType<typeof vi.spyOn>;
let terminateSpy: ReturnType<typeof vi.spyOn>;
let now = 1_000_000;

beforeEach(async () => {
  process.env.JWT_SECRET = 'x'.repeat(40);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  server = http.createServer();
  const wss = createWebSocketServer(server);
  const connected = new Promise<WebSocket>((resolve) => wss.on('connection', resolve));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  client.on('error', () => {});
  client.on('open', () => client.send(JSON.stringify({ type: 'auth', token: signSession('a@b.c') })));
  serverSide = await connected;
  buffered = 0;
  Object.defineProperty(serverSide, 'bufferedAmount', { get: () => buffered, configurable: true });
  sendSpy = vi.spyOn(serverSide, 'send');
  terminateSpy = vi.spyOn(serverSide, 'terminate');
  sendSpy.mockClear(); // auth:ok was already sent
});

afterEach(async () => {
  client.terminate();
  stopWebSocketServer();
  await new Promise<void>((r) => server.close(() => r()));
  vi.restoreAllMocks();
});

const emit = () => eventBus.emit('container:event', containerEvent());

describe('broadcast backpressure wiring', () => {
  it('sends to a client with an empty buffer', () => {
    emit();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(terminateSpy).not.toHaveBeenCalled();
  });

  it('skips a client over 1 MB without terminating it yet', () => {
    buffered = MB + 1;
    emit();
    expect(sendSpy).not.toHaveBeenCalled();
    expect(terminateSpy).not.toHaveBeenCalled();
  });

  it('terminates a client that stays over the limit for 30 s', () => {
    buffered = MB + 1;
    emit();
    now += 29_000;
    emit();
    expect(terminateSpy).not.toHaveBeenCalled();
    now += 1_000;
    emit();
    expect(terminateSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('clears the over-limit clock once the buffer drains', () => {
    buffered = MB + 1;
    emit();
    now += 20_000;
    buffered = 0;
    emit(); // drained: sent, tracker cleared
    expect(sendSpy).toHaveBeenCalledTimes(1);
    buffered = MB + 1;
    now += 20_000; // 40 s after the first overage but only 0 s into the new one
    emit();
    expect(terminateSpy).not.toHaveBeenCalled();
    now += 29_000;
    emit();
    expect(terminateSpy).not.toHaveBeenCalled();
  });
});
