import { Server as HTTPServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';
import { eventBus } from '../services/eventBus';
import { verifySession } from '../auth/session';
import { isAdminEmail } from '../services/users';
import { createWSMessage, WSMessage, WSMessageType } from './types';

const HEARTBEAT_INTERVAL = 30_000;
const AUTH_TIMEOUT = 5_000; // 5 seconds to authenticate after connecting
const MAX_PAYLOAD = 4 * 1024; // 4 KB — auth messages only, no large payloads needed
const MAX_CONNECTIONS_PER_USER = 5;
const MEMBERSHIP_RECHECK_INTERVAL = 60_000; // removed admins lose the socket within this window
// setTimeout overflows (and fires immediately) above 2^31-1 ms.
const MAX_TIMER_MS = 2_147_483_647;

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
let membershipTimer: ReturnType<typeof setInterval> | null = null;
let eventUnsubscribers: Array<() => void> = [];
const clients = new Set<WebSocket>();
const connectionsByUser = new Map<string, number>();

type AuthResult = { valid: true; email: string; exp: number } | { valid: false };

// Valid session token AND the user is still an admin user (any role: viewers get
// the read-only socket).
async function authenticate(token: unknown): Promise<AuthResult> {
  if (typeof token !== 'string') return { valid: false };
  try {
    const session = verifySession(token);
    if (!(await isAdminEmail(session.email))) return { valid: false };
    return { valid: true, email: session.email, exp: session.exp };
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

// Idempotent per socket: 'close' and 'error' can both fire, and the per-user
// count must only drop once.
function releaseConnection(ws: WebSocket): void {
  const state = ws as any;
  clients.delete(ws);
  if (state.expiryTimer) {
    clearTimeout(state.expiryTimer);
    state.expiryTimer = undefined;
  }
  if (state.released) return;
  state.released = true;
  if (state.userEmail) untrackConnection(state.userEmail);
}

async function recheckMembership(): Promise<void> {
  const verdicts = new Map<string, boolean>();
  for (const ws of [...clients]) {
    const email = (ws as any).userEmail as string | undefined;
    if (!email) continue;
    let member = verdicts.get(email);
    if (member === undefined) {
      try {
        member = await isAdminEmail(email);
      } catch (err: any) {
        // Store read failed: keep the socket, retry on the next tick.
        console.warn(`[WebSocket] Membership re-check failed: ${err?.message || err}`);
        continue;
      }
      verdicts.set(email, member);
    }
    if (!member) ws.close(4403, 'Access revoked');
  }
}

export function createWebSocketServer(server: HTTPServer, opts: { membershipRecheckMs?: number } = {}): WebSocketServer {
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

      ws.once('message', async (data) => {
        clearTimeout(authTimer);
        if ((ws as any).authenticated) return; // Already handled or closed
        try {
          const msg = JSON.parse(data.toString());
          const result = msg.type === 'auth' ? await authenticate(msg.token) : { valid: false as const };
          if (ws.readyState !== WebSocket.OPEN) return; // Went away while verifying
          if (!result.valid) {
            ws.close(4003, 'Invalid token');
            return;
          }
          // Enforce per-user connection limit
          if (!trackConnection(result.email)) {
            ws.close(4029, 'Too many connections');
            return;
          }
          (ws as any).authenticated = true;
          (ws as any).userEmail = result.email;
          // The session ends at token expiry; don't wait for the next re-check.
          (ws as any).expiryTimer = setTimeout(
            () => ws.close(4401, 'Session expired'),
            Math.min(Math.max(result.exp * 1000 - Date.now(), 0), MAX_TIMER_MS),
          );
          clients.add(ws);
          (ws as any).isAlive = true;
          ws.send(JSON.stringify({ type: 'auth:ok' }));
          wss!.emit('connection', ws, request);
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

    ws.on('close', () => releaseConnection(ws));
    ws.on('error', () => releaseConnection(ws));
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

  membershipTimer = setInterval(() => {
    recheckMembership().catch(() => {});
  }, opts.membershipRecheckMs ?? MEMBERSHIP_RECHECK_INTERVAL);

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
  if (membershipTimer) {
    clearInterval(membershipTimer);
    membershipTimer = null;
  }
  for (const off of eventUnsubscribers) off();
  eventUnsubscribers = [];
  for (const client of clients) {
    releaseConnection(client);
    client.terminate();
  }
  clients.clear();
  connectionsByUser.clear();
  if (wss) {
    wss.close();
    wss = null;
  }
}
