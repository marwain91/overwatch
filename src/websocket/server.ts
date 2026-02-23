import { Server as HTTPServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { URL } from 'url';
import { eventBus } from '../services/eventBus';
import { createWSMessage, WSMessage } from './types';

const JWT_SECRET = process.env.JWT_SECRET!;
const HEARTBEAT_INTERVAL = 30_000;
const AUTH_TIMEOUT = 5_000; // 5 seconds to authenticate after connecting

let wss: WebSocketServer | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
const clients = new Set<WebSocket>();

function verifyToken(token: string): boolean {
  try {
    jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    return true;
  } catch {
    return false;
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
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    // Only handle /ws path
    const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;
    if (pathname !== '/ws') {
      socket.destroy();
      return;
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
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'auth' && msg.token && verifyToken(msg.token)) {
            (ws as any).authenticated = true;
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
    });

    ws.on('error', () => {
      clients.delete(ws);
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

  // Subscribe to eventBus events and broadcast
  eventBus.on('container:event', (data) => {
    broadcast(createWSMessage('container:event', data));
  });

  eventBus.on('metrics:snapshot', (data) => {
    broadcast(createWSMessage('metrics:snapshot', data));
  });

  eventBus.on('health:change', (data) => {
    broadcast(createWSMessage('health:change', data));
  });

  eventBus.on('alert:fired', (data) => {
    broadcast(createWSMessage('alert:fired', data));
  });

  eventBus.on('alert:resolved', (data) => {
    broadcast(createWSMessage('alert:resolved', data));
  });

  console.log('[WebSocket] Server initialized');
  return wss;
}

export function getConnectedClients(): number {
  return clients.size;
}

export function stopWebSocketServer(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  for (const client of clients) {
    client.terminate();
  }
  clients.clear();
  if (wss) {
    wss.close();
    wss = null;
  }
}
