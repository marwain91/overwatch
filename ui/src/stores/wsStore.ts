import { create } from 'zustand';
import { useAuthStore } from './authStore';
import type { MetricsSnapshot } from '../lib/types';

type WSMessageHandler = (msg: WSMessage) => void;

interface WSMessage {
  type: string;
  data?: unknown;
}

// Browsers answer the server's protocol-level pings without telling JS, so the
// only liveness signal the page sees is data. After the server has proved it
// sends periodic traffic, silence for this long means the socket is half-open
// (NAT/proxy dropped it) and polling must resume. The threshold also scales
// with the largest gap seen so a long monitoring.metrics_interval doesn't flap.
const STALE_AFTER_MS = 60_000;
const WATCHDOG_TICK_MS = 10_000;

interface WSState {
  connected: boolean;
  latestMetrics: MetricsSnapshot | null;
  _ws: WebSocket | null;
  _reconnectTimer: ReturnType<typeof setTimeout> | null;
  _reconnectDelay: number;
  _handlers: Set<WSMessageHandler>;
  _watchdog: ReturnType<typeof setInterval> | null;
  connect: () => void;
  disconnect: () => void;
  subscribe: (handler: WSMessageHandler) => () => void;
}

export const useWSStore = create<WSState>((set, get) => ({
  connected: false,
  latestMetrics: null,
  _ws: null,
  _reconnectTimer: null,
  _reconnectDelay: 1000,
  _handlers: new Set(),
  _watchdog: null,

  connect: () => {
    const state = get();
    const token = useAuthStore.getState().token;
    if (!token || state._ws) return;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws`;

    try {
      const ws = new WebSocket(wsUrl);
      let lastMessageAt = Date.now();
      let maxGapMs = 0;
      let sawData = false;

      const stopWatchdog = () => {
        const timer = get()._watchdog;
        if (timer) clearInterval(timer);
        set({ _watchdog: null });
      };

      // Half-open socket: onclose may take minutes, so drop it ourselves.
      const declareStale = () => {
        stopWatchdog();
        ws.onclose = null;
        ws.onmessage = null;
        try { ws.close(); } catch { /* already gone */ }
        set({ connected: false, _ws: null });
        scheduleReconnect(get()._reconnectDelay);
      };

      const scheduleReconnect = (delay: number) => {
        const timer = setTimeout(() => {
          set({ _reconnectTimer: null });
          if (useAuthStore.getState().token) {
            get().connect();
          }
        }, delay);
        set({
          _reconnectTimer: timer,
          _reconnectDelay: Math.min(delay * 2, 30000),
        });
      };

      ws.onopen = () => {
        // Send auth token as first message instead of in URL (avoids token in logs)
        ws.send(JSON.stringify({ type: 'auth', token }));
      };

      ws.onmessage = (event) => {
        const nowMs = Date.now();
        if (sawData) maxGapMs = Math.max(maxGapMs, nowMs - lastMessageAt);
        lastMessageAt = nowMs;
        try {
          const msg = JSON.parse(event.data) as WSMessage;

          if (msg.type === 'auth:ok') {
            set({ connected: true, _reconnectDelay: 1000 });
            stopWatchdog();
            set({
              _watchdog: setInterval(() => {
                if (sawData && Date.now() - lastMessageAt > Math.max(STALE_AFTER_MS, maxGapMs * 3)) declareStale();
              }, WATCHDOG_TICK_MS),
            });
            return;
          }
          sawData = true;

          if (msg.type === 'metrics:snapshot') {
            set({ latestMetrics: msg.data as MetricsSnapshot });
          }

          for (const handler of get()._handlers) {
            handler(msg);
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onclose = (event) => {
        stopWatchdog();
        set({ connected: false, _ws: null });
        // 4401 session expired / 4403 access revoked: reconnecting cannot succeed.
        if (event.code === 4401 || event.code === 4403) {
          useAuthStore.getState().logout();
          return;
        }
        // 4029 too many connections: back off to the maximum delay.
        const delay = event.code === 4029 ? 30000 : get()._reconnectDelay;
        scheduleReconnect(delay);
      };

      ws.onerror = () => {
        // onclose will fire
      };

      set({ _ws: ws });
    } catch {
      // connection failed
    }
  },

  disconnect: () => {
    const state = get();
    if (state._reconnectTimer) {
      clearTimeout(state._reconnectTimer);
    }
    if (state._watchdog) {
      clearInterval(state._watchdog);
    }
    if (state._ws) {
      state._ws.close();
    }
    set({ _ws: null, connected: false, _reconnectTimer: null, _watchdog: null });
  },

  subscribe: (handler: WSMessageHandler) => {
    get()._handlers.add(handler);
    return () => {
      get()._handlers.delete(handler);
    };
  },
}));
