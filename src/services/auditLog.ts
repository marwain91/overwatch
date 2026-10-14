import * as path from 'path';
import * as fs from 'fs/promises';
import { getDataDir } from '../config';
import { jsonlLogFor } from '../utils/jsonlLog';

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

const SENSITIVE_KEYS = ['password', 'secret', 'token', 'value', 'key', 'credential', 'authorization', 'bearer', 'api_key', 'access_key'];

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
    body: sanitizeBody(entry.body),
    status: entry.status,
    ip: entry.ip,
    ...(entry.force ? { force: true } : {}),
  };
  auditWriter().append(JSON.stringify(full));
}

/** Drain the audit queue — intended for graceful shutdown, the CLI and tests. */
export async function flushAuditLog(): Promise<void> {
  await auditWriter().flush();
}

/** Keep the newest `maxEntries` entries; returns how many were dropped. */
export function pruneAuditLog(maxEntries: number): Promise<number> {
  return auditWriter().prune(maxEntries);
}

/** Newest-first entries matching the (case-insensitive substring) filters; request bodies are omitted. */
export async function readAuditEntries(opts: { limit: number; user?: string; action?: string }): Promise<Omit<AuditEntry, 'body'>[]> {
  let content: string;
  try {
    content = await fs.readFile(getAuditLogFile(), 'utf-8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const lines = content.trim().split('\n').filter(Boolean);
  const user = opts.user?.toLowerCase();
  const action = opts.action?.toLowerCase();
  const entries: Omit<AuditEntry, 'body'>[] = [];
  for (let i = lines.length - 1; i >= 0 && entries.length < opts.limit; i--) {
    try {
      const entry: AuditEntry = JSON.parse(lines[i]);
      if (user && !entry.user.toLowerCase().includes(user)) continue;
      if (action && !entry.action.toLowerCase().includes(action)) continue;
      const { body: _body, ...safe } = entry;
      entries.push(safe);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}
