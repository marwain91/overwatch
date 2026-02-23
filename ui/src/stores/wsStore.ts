import { create } from 'zustand';
import { useAuthStore } from './authStore';
import type { MetricsSnapshot } from '../lib/types';

type WSMessageHandler = (msg: WSMessage) => void;

interface WSMessage {
  type: string;
  data?: unknown;
}

interface WSState {
  connected: boolean;
  latestMetrics: MetricsSnapshot | null;
  _ws: WebSocket | null;
  _reconnectTimer: ReturnType<typeof setTimeout> | null;
  _reconnectDelay: number;
  _handlers: Set<WSMessageHandler>;
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

  connect: () => {
    const state = get();
    const token = useAuthStore.getState().token;
    if (!token || state._ws) return;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws`;

    try {
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        // Send auth token as first message instead of in URL (avoids token in logs)
        ws.send(JSON.stringify({ type: 'auth', token }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as WSMessage;

          if (msg.type === 'auth:ok') {
            set({ connected: true, _reconnectDelay: 1000 });
            return;
          }

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

      ws.onclose = () => {
        set({ connected: false, _ws: null });
        // Schedule reconnect
        const delay = get()._reconnectDelay;
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
    if (state._ws) {
      state._ws.close();
    }
    set({ _ws: null, connected: false, _reconnectTimer: null });
  },

  subscribe: (handler: WSMessageHandler) => {
    get()._handlers.add(handler);
    return () => {
      get()._handlers.delete(handler);
    };
  },
}));
