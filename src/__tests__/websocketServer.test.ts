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
