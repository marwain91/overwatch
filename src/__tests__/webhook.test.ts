import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { sendWebhook } from '../notifications/webhook';

const prev = process.env.OVERWATCH_ALLOW_PRIVATE_WEBHOOK;
let server: http.Server;
let status = 200;
let hits = 0;

const alert = { id: 'a', ruleId: 'r', ruleName: 'R', severity: 'info', message: 'm', firedAt: new Date().toISOString() } as any;
const channelFor = (port: number) => ({ id: 'c', name: 'Hook', type: 'webhook', enabled: true, config: { url: `http://127.0.0.1:${port}/h` } }) as any;

beforeEach(async () => {
  status = 200;
  hits = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  server = http.createServer((_req, res) => { hits++; res.statusCode = status; res.end(); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
});

afterEach(async () => {
  if (prev === undefined) delete process.env.OVERWATCH_ALLOW_PRIVATE_WEBHOOK;
  else process.env.OVERWATCH_ALLOW_PRIVATE_WEBHOOK = prev;
  vi.restoreAllMocks();
  await new Promise<void>(r => server.close(() => r()));
});

describe('sendWebhook', () => {
  it('rethrows the final delivery failure after one retry', async () => {
    process.env.OVERWATCH_ALLOW_PRIVATE_WEBHOOK = '1';
    status = 503;
    const port = (server.address() as AddressInfo).port;
    await expect(sendWebhook(channelFor(port), alert)).rejects.toThrow('Webhook returned 503');
    expect(hits).toBe(2);
  });

  it('resolves on success', async () => {
    process.env.OVERWATCH_ALLOW_PRIVATE_WEBHOOK = '1';
    const port = (server.address() as AddressInfo).port;
    await expect(sendWebhook(channelFor(port), alert)).resolves.toBeUndefined();
    expect(hits).toBe(1);
  });

  it('blocks private targets at send time unless OVERWATCH_ALLOW_PRIVATE_WEBHOOK=1', async () => {
    delete process.env.OVERWATCH_ALLOW_PRIVATE_WEBHOOK;
    const port = (server.address() as AddressInfo).port;
    await expect(sendWebhook(channelFor(port), alert)).rejects.toThrow(/private|internal/);
    expect(hits).toBe(0);
  });

  it('keeps blocking non-http schemes even with the private flag', async () => {
    process.env.OVERWATCH_ALLOW_PRIVATE_WEBHOOK = '1';
    await expect(sendWebhook({ ...channelFor(1), config: { url: 'file:///etc/passwd' } }, alert)).rejects.toThrow(/http/);
  });
});
