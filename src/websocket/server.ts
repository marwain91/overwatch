import { Server as HTTPServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { URL } from 'url';
import { eventBus } from '../services/eventBus';
import { createWSMessage, WSMessage, WSMessageType } from './types';

const JWT_SECRET = process.env.JWT_SECRET!;
const HEARTBEAT_INTERVAL = 30_000;
const AUTH_TIMEOUT = 5_000; // 5 seconds to authenticate after connecting
const MAX_PAYLOAD = 4 * 1024; // 4 KB — auth messages only, no large payloads needed
const MAX_CONNECTIONS_PER_USER = 5;

// eventBus events relayed verbatim to every authenticated client.
const BROADCAST_EVENTS: WSMessageType[] = [
  'container:event',
  'metrics:snapshot',
  'health:change',
  'alert:fired',
  'alert:resolved',
  'tenant:update:progress',
];

let wss: WebSocketServer | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let eventUnsubscribers: Array<() => void> = [];
const clients = new Set<WebSocket>();
const connectionsByUser = new Map<string, number>();

function verifyToken(token: string): { valid: boolean; email?: string } {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as { email: string };
    return { valid: true, email: decoded.email };
  } catch {
    return { valid: false };
  }
}

function trackConnection(email: string): boolean {
  const count = connectionsByUser.get(email) || 0;
  if (count >= MAX_CONNECTIONS_PER_USER) return false;
  connectionsByUser.set(email, count + 1);
  return true;
}

function untrackConnection(email: string): void {
  const count = connectionsByUser.get(email) || 0;
  if (count <= 1) {
    connectionsByUser.delete(email);
  } else {
    connectionsByUser.set(email, count - 1);
  }
}

function broadcast(msg: WSMessage): void {
  const data = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

export function createWebSocketServer(server: HTTPServer): WebSocketServer {
  wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  server.on('upgrade', (request, socket, head) => {
    // Only handle /ws path
    const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }

    // Validate origin — must match the Host header (same-origin) when present.
    // Missing origin is allowed (non-browser clients, some proxy configs).
    const origin = request.headers.origin;
    const host = request.headers.host;
    if (origin && host) {
      try {
        const originHost = new URL(origin).host;
        if (originHost !== host) {
          socket.destroy();
          return;
        }
      } catch {
        socket.destroy();
        return;
      }
    }

    wss!.handleUpgrade(request, socket, head, (ws) => {
      // First-message auth only — token must be sent as first WS message (not in URL)
      (ws as any).authenticated = false;

      const authTimer = setTimeout(() => {
        if (!(ws as any).authenticated) {
          ws.close(4001, 'Authentication timeout');
        }
      }, AUTH_TIMEOUT);

      ws.once('message', (data) => {
        clearTimeout(authTimer);
        if ((ws as any).authenticated) return; // Already handled or closed
        try {
          const msg = JSON.parse(data.toString());
          const result = verifyToken(msg.token);
          if (msg.type === 'auth' && msg.token && result.valid && result.email) {
            // Enforce per-user connection limit
            if (!trackConnection(result.email)) {
              ws.close(4029, 'Too many connections');
              return;
            }
            (ws as any).authenticated = true;
            (ws as any).userEmail = result.email;
            clients.add(ws);
            (ws as any).isAlive = true;
            ws.send(JSON.stringify({ type: 'auth:ok' }));
            wss!.emit('connection', ws, request);
          } else {
            ws.close(4003, 'Invalid token');
          }
        } catch {
          ws.close(4003, 'Invalid auth message');
        }
      });
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    ws.on('pong', () => {
      (ws as any).isAlive = true;
    });

    ws.on('close', () => {
      clients.delete(ws);
      const email = (ws as any).userEmail;
      if (email) untrackConnection(email);
    });

    ws.on('error', () => {
      clients.delete(ws);
      const email = (ws as any).userEmail;
      if (email) untrackConnection(email);
    });
  });

  // Heartbeat to detect dead connections
  heartbeatTimer = setInterval(() => {
    for (const ws of clients) {
      if ((ws as any).isAlive === false) {
        clients.delete(ws);
        ws.terminate();
        continue;
      }
      (ws as any).isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL);

  // Subscribe to eventBus events and broadcast. Handlers are kept so stop can
  // remove them; otherwise every stop/create cycle stacks another listener
  // and each event is broadcast once per cycle.
  for (const type of BROADCAST_EVENTS) {
    const handler = (data: unknown) => broadcast(createWSMessage(type, data));
    eventBus.on(type, handler);
    eventUnsubscribers.push(() => eventBus.off(type, handler));
  }

  console.log('[WebSocket] Server initialized');
  return wss;
}

export function stopWebSocketServer(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  for (const off of eventUnsubscribers) off();
  eventUnsubscribers = [];
  for (const client of clients) {
    client.terminate();
  }
  clients.clear();
  connectionsByUser.clear();
  if (wss) {
    wss.close();
    wss = null;
  }
}
