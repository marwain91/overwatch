import { describe, it, expect, afterEach, vi } from 'vitest';
import * as http from 'http';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('WebSocket server lifecycle', () => {
  it('removes its eventBus listeners on stop so restarts do not double-broadcast', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(32);
    const { eventBus } = await import('../services/eventBus');
    const { createWebSocketServer, stopWebSocketServer } = await import('../websocket/server');
    const baseline = eventBus.listenerCount('metrics:snapshot');

    for (let i = 0; i < 2; i++) {
      const server = http.createServer();
      createWebSocketServer(server);
      expect(eventBus.listenerCount('metrics:snapshot')).toBe(baseline + 1);
      stopWebSocketServer();
      expect(eventBus.listenerCount('metrics:snapshot')).toBe(baseline);
    }
  });
});

describe('WebSocket broadcast backpressure', () => {
  const MB = 1024 * 1024;

  async function load() {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(32);
    return import('../websocket/server');
  }

  it('sends to a client whose buffer is at or under 1 MB', async () => {
    const { decideBackpressure } = await load();
    expect(decideBackpressure(0, undefined, 1000)).toEqual({ action: 'send', overSince: undefined });
    expect(decideBackpressure(MB, undefined, 1000)).toEqual({ action: 'send', overSince: undefined });
  });

  it('skips a client over 1 MB and starts the over-limit clock', async () => {
    const { decideBackpressure } = await load();
    expect(decideBackpressure(MB + 1, undefined, 1000)).toEqual({ action: 'skip', overSince: 1000 });
  });

  it('keeps skipping while over the limit for less than 30 s', async () => {
    const { decideBackpressure } = await load();
    expect(decideBackpressure(2 * MB, 1000, 1000 + 29_999)).toEqual({ action: 'skip', overSince: 1000 });
  });

  it('terminates a client continuously over the limit for 30 s', async () => {
    const { decideBackpressure } = await load();
    expect(decideBackpressure(2 * MB, 1000, 1000 + 30_000).action).toBe('terminate');
  });

  it('clears the tracker when the client drops back under the limit', async () => {
    const { decideBackpressure } = await load();
    expect(decideBackpressure(100, 1000, 1000 + 40_000)).toEqual({ action: 'send', overSince: undefined });
  });
});
