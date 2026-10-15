import { Server as HTTPServer, IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';
import { eventBus, type BroadcastEvent } from '../services/eventBus';
import { verifySession } from '../auth/session';
import { isSessionRevoked } from '../auth/sessionRevocations';
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
// At the total, the oldest unauthenticated socket is evicted rather than the
// new one refused: a real client authenticates within a round trip, so a flood
// of idle sockets cannot keep admins out.
const MAX_PENDING = 500;
const UPGRADE_RATE = { windowMs: 60_000, max: 60 };
const MAX_TRACKED_IPS = 10_000;
// A refused socket gets this long to answer the close frame before it is cut.
const CLOSE_GRACE_MS = 1_000;

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

interface SocketState {
  authenticated: boolean;
  userEmail?: string;
  sessionId?: string;
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

type AuthResult = { valid: true; email: string; exp: number; jti?: string } | { valid: false };

// Valid, not logged-out session token AND the user is still an admin user
// (any role: viewers get the read-only socket).
async function authenticate(token: unknown): Promise<AuthResult> {
  if (typeof token !== 'string') return { valid: false };
  try {
    const session = verifySession(token);
    if (session.jti && (await isSessionRevoked(session.jti))) return { valid: false };
    if (!(await isAdminEmail(session.email))) return { valid: false };
    return { valid: true, email: session.email, exp: session.exp, jti: session.jti };
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
    const { userEmail: email, sessionId } = stateOf(ws);
    if (!email) continue;
    // Logged out elsewhere (another tab, or the token was revoked): the session is over.
    if (sessionId && (await isSessionRevoked(sessionId))) {
      ws.close(4401, 'Session ended');
      continue;
    }
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
function refuseUpgrade(socket: Duplex): void {
  socket.once('finish', () => socket.destroy());
  socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nRetry-After: 60\r\nContent-Length: 0\r\n\r\n');
}

/**
 * Fixed-window upgrade counter per client IP with bounded memory. Every
 * window has the same length and a reset re-inserts its key, so the Map's
 * insertion order is also expiry order: expired entries are dropped from the
 * front, and at the cap the oldest entry is evicted (its count starts over)
 * instead of refusing unknown addresses.
 */
export function createUpgradeLimiter(opts: { windowMs: number; max: number; maxTracked?: number }) {
  const maxTracked = opts.maxTracked ?? MAX_TRACKED_IPS;
  const byIp = new Map<string, { count: number; resetAt: number }>();
  return {
    allow(ip: string): boolean {
      const now = Date.now();
      for (const [key, entry] of byIp) {
        if (now <= entry.resetAt) break;
        byIp.delete(key);
      }
      const entry = byIp.get(ip);
      if (entry) {
        entry.count++;
        return entry.count <= opts.max;
      }
      if (byIp.size >= maxTracked) byIp.delete(byIp.keys().next().value!);
      byIp.set(ip, { count: 1, resetAt: now + opts.windowMs });
      return true;
    },
    size: () => byIp.size,
  };
}

export interface WebSocketServerOptions {
  membershipRecheckMs?: number;
  membershipReadTimeoutMs?: number;
  /** Client address of an upgrade request; index.ts resolves it exactly like Express's req.ip. */
  clientIp?: (req: IncomingMessage) => string;
  maxPendingPerIp?: number;
  maxPending?: number;
  upgradeRate?: { windowMs: number; max: number };
  authTimeoutMs?: number;
}

export function createWebSocketServer(server: HTTPServer, opts: WebSocketServerOptions = {}): WebSocketServer {
  wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const clientIp = opts.clientIp ?? ((req: IncomingMessage) => req.socket.remoteAddress ?? 'unknown');
  const maxPendingPerIp = opts.maxPendingPerIp ?? MAX_PENDING_PER_IP;
  const maxPending = opts.maxPending ?? MAX_PENDING;
  const authTimeoutMs = opts.authTimeoutMs ?? AUTH_TIMEOUT;
  // Per server instance: a socket of a stopped server that closes late must
  // not release a slot of its successor.
  const upgrades = createUpgradeLimiter(opts.upgradeRate ?? UPGRADE_RATE);
  const pendingByIp = new Map<string, number>();
  // Unauthenticated sockets, oldest first; each value evicts its socket.
  const pending = new Map<Duplex, () => void>();

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
    if (!upgrades.allow(ip) || (pendingByIp.get(ip) ?? 0) >= maxPendingPerIp) {
      refuseUpgrade(socket);
      return;
    }
    if (pending.size >= maxPending) pending.values().next().value!();

    // Held from here until the socket authenticates, is refused, or goes away,
    // whichever is first.
    pendingByIp.set(ip, (pendingByIp.get(ip) ?? 0) + 1);
    let pendingHeld = true;
    const releasePending = () => {
      if (!pendingHeld) return;
      pendingHeld = false;
      pending.delete(socket);
      const left = (pendingByIp.get(ip) ?? 1) - 1;
      if (left <= 0) pendingByIp.delete(ip);
      else pendingByIp.set(ip, left);
    };
    pending.set(socket, () => { releasePending(); socket.destroy(); });
    socket.once('close', releasePending);

    wss!.handleUpgrade(request, socket, head, (ws) => {
      // An 'error' with no listener is uncaught and kills the process, and an
      // unauthenticated client can trigger one (a frame over maxPayload). ws
      // closes the socket itself; the 'connection' listener releases the slot.
      ws.on('error', () => {});

      // First-message auth only — token must be sent as first WS message (not in URL)
      const state = stateOf(ws);

      // A refused socket frees its slot now; a client that never answers the
      // close frame would otherwise hold it for ws's 30 s closing timeout.
      const refuse = (code: number, reason: string) => {
        releasePending();
        ws.close(code, reason);
        setTimeout(() => ws.terminate(), CLOSE_GRACE_MS).unref();
      };

      const authTimer = setTimeout(() => {
        if (!state.authenticated) refuse(4001, 'Authentication timeout');
      }, authTimeoutMs);

      ws.once('message', async (data) => {
        clearTimeout(authTimer);
        if (state.authenticated) return; // Already handled or closed
        try {
          const msg = JSON.parse(data.toString());
          const result = msg.type === 'auth' ? await authenticate(msg.token) : { valid: false as const };
          if (ws.readyState !== WebSocket.OPEN) return; // Went away while verifying
          if (!result.valid) {
            refuse(4003, 'Invalid token');
            return;
          }
          // Enforce per-user connection limit
          if (!trackConnection(result.email)) {
            refuse(4029, 'Too many connections');
            return;
          }
          state.authenticated = true;
          state.userEmail = result.email;
          state.sessionId = result.jti;
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
          refuse(4003, 'Invalid auth message');
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
