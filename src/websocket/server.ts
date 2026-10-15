import { Server as HTTPServer, IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';
import { eventBus, type BroadcastEvent } from '../services/eventBus';
import { verifySession } from '../auth/session';
import { isAdminEmail } from '../services/users';
import { createWSMessage, WSMessage } from './types';

const HEARTBEAT_INTERVAL = 30_000;
const AUTH_TIMEOUT = 5_000; // 5 seconds to authenticate after connecting
const MAX_PAYLOAD = 4 * 1024; // 4 KB — auth messages only, no large payloads needed
const MAX_CONNECTIONS_PER_USER = 5;
const MEMBERSHIP_RECHECK_INTERVAL = 60_000; // removed admins lose the socket within this window
const MEMBERSHIP_READ_TIMEOUT = 10_000; // a store read that never settles must not wedge the re-check loop
// setTimeout overflows (and fires immediately) above 2^31-1 ms.
const MAX_TIMER_MS = 2_147_483_647;
// Upgrades bypass the Express rate limits, so the socket gets its own:
// unauthenticated sockets per client IP and in total, and upgrades per IP.
const MAX_PENDING_PER_IP = 10;
const MAX_PENDING = 200;
const UPGRADE_RATE = { windowMs: 60_000, max: 60 };

// eventBus events relayed verbatim to every authenticated client.
const BROADCAST_EVENTS: BroadcastEvent[] = [
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
let upgradeSweepTimer: ReturnType<typeof setInterval> | null = null;

interface SocketState {
  authenticated: boolean;
  userEmail?: string;
  expiryTimer?: ReturnType<typeof setTimeout>;
  released?: boolean;
  isAlive?: boolean;
}
const socketState = new WeakMap<WebSocket, SocketState>();
const stateOf = (ws: WebSocket): SocketState => {
  let state = socketState.get(ws);
  if (!state) {
    state = { authenticated: false };
    socketState.set(ws, state);
  }
  return state;
};

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

const MAX_BUFFERED_BYTES = 1024 * 1024; // 1 MB of unsent data marks a client as slow
const SLOW_CLIENT_TERMINATE_MS = 30_000;
const slowSince = new WeakMap<WebSocket, number>();

// Slow clients are skipped (their buffer only grows otherwise) and dropped if
// they stay over the limit; the UI reconnects and refetches on its own.
export function decideBackpressure(
  bufferedAmount: number,
  overSince: number | undefined,
  now: number,
): { action: 'send' | 'skip' | 'terminate'; overSince: number | undefined } {
  if (bufferedAmount <= MAX_BUFFERED_BYTES) return { action: 'send', overSince: undefined };
  const since = overSince ?? now;
  if (now - since >= SLOW_CLIENT_TERMINATE_MS) return { action: 'terminate', overSince: since };
  return { action: 'skip', overSince: since };
}

function broadcast(msg: WSMessage): void {
  const data = JSON.stringify(msg);
  const now = Date.now();
  for (const client of clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    const decision = decideBackpressure(client.bufferedAmount, slowSince.get(client), now);
    if (decision.overSince === undefined) slowSince.delete(client);
    else slowSince.set(client, decision.overSince);
    if (decision.action === 'send') client.send(data);
    else if (decision.action === 'terminate') client.terminate();
  }
}

// Idempotent per socket: 'close' and 'error' can both fire, and the per-user
// count must only drop once.
function releaseConnection(ws: WebSocket): void {
  const state = stateOf(ws);
  clients.delete(ws);
  if (state.expiryTimer) {
    clearTimeout(state.expiryTimer);
    state.expiryTimer = undefined;
  }
  if (state.released) return;
  state.released = true;
  if (state.userEmail) untrackConnection(state.userEmail);
}

// A slow store must not stack re-checks: a tick that finds the previous run
// still going is skipped.
let rechecking = false;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function recheckMembership(readTimeoutMs: number): Promise<void> {
  if (rechecking) return;
  rechecking = true;
  try {
    await recheckAll(readTimeoutMs);
  } finally {
    rechecking = false;
  }
}

async function recheckAll(readTimeoutMs: number): Promise<void> {
  const verdicts = new Map<string, boolean>();
  for (const ws of [...clients]) {
    const email = stateOf(ws).userEmail;
    if (!email) continue;
    let member = verdicts.get(email);
    if (member === undefined) {
      try {
        member = await withTimeout(isAdminEmail(email), readTimeoutMs);
      } catch (err: any) {
        // Store read failed or timed out: keep the socket, retry on the next tick.
        console.warn(`[WebSocket] Membership re-check failed: ${err?.message || err}`);
        continue;
      }
      verdicts.set(email, member);
    }
    if (!member) ws.close(4403, 'Access revoked');
  }
}

// Answers a refused upgrade with a plain HTTP status, before any WebSocket handshake.
function refuseUpgrade(socket: Duplex, status: 429 | 503): void {
  const reason = status === 429 ? 'Too Many Requests' : 'Service Unavailable';
  socket.once('finish', () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nRetry-After: 60\r\nContent-Length: 0\r\n\r\n`);
}

export interface WebSocketServerOptions {
  membershipRecheckMs?: number;
  membershipReadTimeoutMs?: number;
  /** Client address of an upgrade request; index.ts resolves it exactly like Express's req.ip. */
  clientIp?: (req: IncomingMessage) => string;
  maxPendingPerIp?: number;
  maxPending?: number;
  upgradeRate?: { windowMs: number; max: number };
}

export function createWebSocketServer(server: HTTPServer, opts: WebSocketServerOptions = {}): WebSocketServer {
  wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const clientIp = opts.clientIp ?? ((req: IncomingMessage) => req.socket.remoteAddress ?? 'unknown');
  const maxPendingPerIp = opts.maxPendingPerIp ?? MAX_PENDING_PER_IP;
  const maxPending = opts.maxPending ?? MAX_PENDING;
  const upgradeRate = opts.upgradeRate ?? UPGRADE_RATE;
  // Per server instance: a socket of a stopped server that closes late must
  // not release a slot of its successor.
  const pendingByIp = new Map<string, number>();
  let pendingTotal = 0;
  const upgradesByIp = new Map<string, { count: number; resetAt: number }>();

  const upgradeAllowed = (ip: string): boolean => {
    const now = Date.now();
    const entry = upgradesByIp.get(ip);
    if (!entry || now > entry.resetAt) {
      upgradesByIp.set(ip, { count: 1, resetAt: now + upgradeRate.windowMs });
      return true;
    }
    entry.count++;
    return entry.count <= upgradeRate.max;
  };

  upgradeSweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of upgradesByIp) if (now > entry.resetAt) upgradesByIp.delete(ip);
  }, 60_000);
  upgradeSweepTimer.unref();

  server.on('upgrade', (request, socket, head) => {
    // Node drops its own 'error' listener from an upgraded socket; a reset
    // while we answer a refused upgrade must not become an uncaught error.
    socket.on('error', () => {});

    // Only handle /ws path. The request target is client-controlled and may
    // not parse; a throw here is uncaught and would take the whole process
    // down, so an unparseable request is dropped. The Host header is not used
    // as the base: it is client-controlled too and need not be a valid host.
    let pathname: string;
    try {
      pathname = new URL(request.url || '', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
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

    let ip: string;
    try {
      ip = clientIp(request) || 'unknown';
    } catch {
      socket.destroy();
      return;
    }
    if (!upgradeAllowed(ip)) {
      refuseUpgrade(socket, 429);
      return;
    }
    if ((pendingByIp.get(ip) ?? 0) >= maxPendingPerIp) {
      refuseUpgrade(socket, 429);
      return;
    }
    if (pendingTotal >= maxPending) {
      refuseUpgrade(socket, 503);
      return;
    }

    // Held from here until the socket authenticates or goes away, whichever is
    // first (a failed handshake, a refused token and a timeout all close it).
    pendingTotal++;
    pendingByIp.set(ip, (pendingByIp.get(ip) ?? 0) + 1);
    let pendingHeld = true;
    const releasePending = () => {
      if (!pendingHeld) return;
      pendingHeld = false;
      pendingTotal--;
      const left = (pendingByIp.get(ip) ?? 1) - 1;
      if (left <= 0) pendingByIp.delete(ip);
      else pendingByIp.set(ip, left);
    };
    socket.once('close', releasePending);

    wss!.handleUpgrade(request, socket, head, (ws) => {
      // An 'error' with no listener is uncaught and kills the process, and an
      // unauthenticated client can trigger one (a frame over maxPayload). ws
      // closes the socket itself; the 'connection' listener releases the slot.
      ws.on('error', () => {});

      // First-message auth only — token must be sent as first WS message (not in URL)
      const state = stateOf(ws);

      const authTimer = setTimeout(() => {
        if (!state.authenticated) {
          ws.close(4001, 'Authentication timeout');
        }
      }, AUTH_TIMEOUT);

      ws.once('message', async (data) => {
        clearTimeout(authTimer);
        if (state.authenticated) return; // Already handled or closed
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
          state.authenticated = true;
          state.userEmail = result.email;
          releasePending();
          // The session ends at token expiry; don't wait for the next re-check.
          state.expiryTimer = setTimeout(
            () => ws.close(4401, 'Session expired'),
            Math.min(Math.max(result.exp * 1000 - Date.now(), 0), MAX_TIMER_MS),
          );
          clients.add(ws);
          state.isAlive = true;
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
      stateOf(ws).isAlive = true;
    });

    ws.on('close', () => releaseConnection(ws));
    ws.on('error', () => releaseConnection(ws));
  });

  // Heartbeat to detect dead connections
  heartbeatTimer = setInterval(() => {
    for (const ws of clients) {
      const state = stateOf(ws);
      if (state.isAlive === false) {
        clients.delete(ws);
        ws.terminate();
        continue;
      }
      state.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL);

  membershipTimer = setInterval(() => {
    recheckMembership(opts.membershipReadTimeoutMs ?? MEMBERSHIP_READ_TIMEOUT).catch(() => {});
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
  if (upgradeSweepTimer) {
    clearInterval(upgradeSweepTimer);
    upgradeSweepTimer = null;
  }
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
