import * as path from 'path';
import { getDataDir } from '../config';
import { jsonlLogFor, readLinesReverse } from '../utils/jsonlLog';

export interface AuditEntry {
  timestamp: string;
  user: string;
  action: string;
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  force?: boolean;
  status: number;
  ip: string;
}

export function getAuditLogFile(): string {
  return path.join(getDataDir(), 'audit.log');
}

function auditWriter() {
  return jsonlLogFor(getAuditLogFile(), 'audit');
}

// Substrings of a key (any depth, case-insensitive) whose value is never stored.
// `users` is a basicAuth/digestAuth user list (htpasswd hashes); basicauth and
// digestauth match the raw Traefik label keys that carry the same.
const SENSITIVE_KEYS = ['password', 'secret', 'token', 'value', 'key', 'credential', 'authorization', 'bearer', 'api_key', 'access_key', 'users', 'basicauth', 'digestauth'];

// Bodies are kept for forensics, not replay. Uncapped, one large request (an
// app definition, a pasted file; up to the 1 MB JSON limit) bloated every
// later read and prune of the log.
export const MAX_AUDIT_BODY_BYTES = 4096;

function isPlainObject(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function originOnly(url: string): string {
  try {
    const { origin } = new URL(url);
    return origin === 'null' ? '[redacted]' : origin;
  } catch {
    return '[redacted]';
  }
}

export function sanitizeValue(val: unknown, depth: number = 0): unknown {
  if (depth > 5 || val === null || val === undefined) return val;
  if (Array.isArray(val)) return val.map(v => sanitizeValue(v, depth + 1));
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      if (SENSITIVE_KEYS.some(s => key.toLowerCase().includes(s))) {
        sanitized[key] = '[redacted]';
      } else if (key.toLowerCase() === 'headers' && isPlainObject(obj[key])) {
        // Webhook header values routinely carry credentials under arbitrary names.
        sanitized[key] = Object.fromEntries(Object.keys(obj[key] as object).map(k => [k, '[redacted]']));
      } else if (key === 'config' && isPlainObject(obj[key]) && typeof (obj[key] as any).url === 'string') {
        // Notification-channel config: webhook URLs embed secrets in path/query (Slack, Teams, ...).
        const config = sanitizeValue(obj[key], depth + 1) as Record<string, unknown>;
        sanitized[key] = { ...config, url: originOnly((obj[key] as any).url) };
      } else {
        sanitized[key] = sanitizeValue(obj[key], depth + 1);
      }
    }
    return sanitized;
  }
  return val;
}

export function sanitizeBody(body: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!body) return undefined;
  return sanitizeValue(body) as Record<string, unknown>;
}

/** A redacted body over the cap becomes a marker with its size and the start of its JSON. */
function capBody(body: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!body) return undefined;
  const json = JSON.stringify(body);
  const bytes = Buffer.byteLength(json);
  if (bytes <= MAX_AUDIT_BODY_BYTES) return body;
  let preview = json.slice(0, MAX_AUDIT_BODY_BYTES);
  // Re-encoding escapes quotes and multi-byte text, so shrink until it fits.
  for (;;) {
    const capped = { _truncated: true, _bytes: bytes, _preview: preview };
    if (Buffer.byteLength(JSON.stringify(capped)) <= MAX_AUDIT_BODY_BYTES) return capped;
    preview = preview.slice(0, Math.floor(preview.length * 0.8));
  }
}

/**
 * Append an audit entry. Callable from HTTP middleware, the CLI and MCP tools;
 * sensitive body keys are redacted here, so callers cannot forget to. Writes go
 * through one serialized queue shared with retention's prune.
 */
export function writeAuditEntry(entry: Omit<AuditEntry, 'timestamp'> & { timestamp?: string }): void {
  const full: AuditEntry = {
    timestamp: entry.timestamp ?? new Date().toISOString(),
    user: entry.user,
    action: entry.action,
    method: entry.method,
    path: entry.path,
    query: entry.query ? (sanitizeValue(entry.query) as Record<string, unknown>) : undefined,
    body: capBody(sanitizeBody(entry.body)),
    status: entry.status,
    ip: entry.ip,
    ...(entry.force ? { force: true } : {}),
  };
  auditWriter().append(JSON.stringify(full));
}

/**
 * Drain the audit queue — intended for graceful shutdown, the CLI and tests.
 * Gives up after `timeoutMs` (an unwritable file or a stuck lock must not hold
 * shutdown until the forced exit); unwritten entries are logged as lost.
 */
export async function flushAuditLog(timeoutMs: number = 5000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<void>(resolve => {
    timer = setTimeout(() => {
      console.error(`[audit] flush timed out after ${timeoutMs}ms; queued entries may not have been written`);
      resolve();
    }, timeoutMs);
  });
  try {
    await Promise.race([auditWriter().flush(), timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Keep the newest `maxEntries` entries, at most `maxBytes` of them; returns how many were dropped. */
export function pruneAuditLog(maxEntries: number, maxBytes?: number): Promise<number> {
  return auditWriter().prune(maxEntries, maxBytes);
}

/**
 * Newest-first entries matching the (case-insensitive substring) filters;
 * request bodies are omitted. Reads backwards from the end of the file and
 * stops once `limit` entries matched.
 */
export async function readAuditEntries(opts: { limit: number; user?: string; action?: string }): Promise<Omit<AuditEntry, 'body'>[]> {
  const user = opts.user?.toLowerCase();
  const action = opts.action?.toLowerCase();
  const entries: Omit<AuditEntry, 'body'>[] = [];
  if (opts.limit <= 0) return entries;
  try {
    for await (const line of readLinesReverse(getAuditLogFile())) {
      let entry: AuditEntry;
      try {
        entry = JSON.parse(line);
        if (user && !entry.user.toLowerCase().includes(user)) continue;
        if (action && !entry.action.toLowerCase().includes(action)) continue;
      } catch {
        continue; // Skip malformed lines
      }
      const { body: _body, ...safe } = entry;
      entries.push(safe);
      if (entries.length >= opts.limit) break;
    }
  } catch (err: any) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries;
}
