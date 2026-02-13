import { Request, Response, NextFunction } from 'express';
import * as fs from 'fs/promises';
import * as path from 'path';
import jwt from 'jsonwebtoken';
import { getDataDir } from '../config';

interface AuditEntry {
  timestamp: string;
  user: string;
  action: string;
  method: string;
  path: string;
  body?: Record<string, unknown>;
  status: number;
  ip: string;
}

function getAuditLogFile(): string {
  return path.join(getDataDir(), 'audit.log');
}

function getUserFromRequest(req: Request): string {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return 'anonymous';

  try {
    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { email?: string };
    return decoded.email || 'unknown';
  } catch {
    return 'unknown';
  }
}

function describeAction(method: string, reqPath: string, body?: Record<string, unknown>): string {
  // Tenant operations
  if (reqPath === '/api/tenants' && method === 'POST') return `create tenant ${body?.tenantId || ''}`;
  if (reqPath.match(/^\/api\/tenants\/[^/]+$/) && method === 'PATCH') return `update tenant ${reqPath.split('/')[3]}`;
  if (reqPath.match(/^\/api\/tenants\/[^/]+$/) && method === 'DELETE') return `delete tenant ${reqPath.split('/')[3]}`;
  if (reqPath.match(/\/start$/) && method === 'POST') return `start tenant ${reqPath.split('/')[3]}`;
  if (reqPath.match(/\/stop$/) && method === 'POST') return `stop tenant ${reqPath.split('/')[3]}`;
  if (reqPath.match(/\/restart$/) && method === 'POST') return `restart tenant ${reqPath.split('/')[3]}`;
  if (reqPath.match(/\/access-token$/) && method === 'POST') return `access tenant ${reqPath.split('/')[3]}`;

  // Admin operations
  if (reqPath === '/api/admin-users' && method === 'POST') return `add admin ${body?.email || ''}`;
  if (reqPath.match(/^\/api\/admin-users\//) && method === 'DELETE') return `remove admin ${decodeURIComponent(reqPath.split('/')[3])}`;

  // Env var operations
  if (reqPath === '/api/env-vars' && method === 'POST') return `set env var ${body?.key || ''}`;
  if (reqPath.match(/^\/api\/env-vars\/[^/]+$/) && method === 'DELETE') return `delete env var ${decodeURIComponent(reqPath.split('/')[3])}`;
  if (reqPath.match(/\/overrides$/) && method === 'POST') return `set override ${body?.key || ''} for ${reqPath.split('/')[4]}`;
  if (reqPath.match(/\/overrides\//) && method === 'DELETE') return `delete override ${decodeURIComponent(reqPath.split('/')[6])} for ${reqPath.split('/')[4]}`;

  // Backup operations
  if (reqPath === '/api/backups/init' && method === 'POST') return 'init backup repo';
  if (reqPath === '/api/backups/unlock' && method === 'POST') return 'unlock backup repo';
  if (reqPath === '/api/backups' && method === 'POST') return `create backup for ${body?.tenantId || ''}`;
  if (reqPath.match(/\/restore$/) && method === 'POST') return `restore backup to ${body?.tenantId || ''}`;
  if (reqPath.match(/\/create-tenant$/) && method === 'POST') return `clone backup to new tenant ${body?.tenantId || ''}`;
  if (reqPath.match(/^\/api\/backups\/[^/]+$/) && method === 'DELETE') return `delete backup ${reqPath.split('/')[3]}`;

  return `${method} ${reqPath}`;
}

function sanitizeBody(body: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!body) return undefined;
  const sanitized = { ...body };
  const sensitiveKeys = ['password', 'secret', 'token', 'value'];
  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some(s => key.toLowerCase().includes(s))) {
      sanitized[key] = '[redacted]';
    }
  }
  return sanitized;
}

export function auditLog(req: Request, res: Response, next: NextFunction) {
  // Only audit state-changing requests
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const originalJson = res.json.bind(res);
  res.json = function (body: unknown) {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      user: getUserFromRequest(req),
      action: describeAction(req.method, req.path, req.body),
      method: req.method,
      path: req.path,
      body: sanitizeBody(req.body),
      status: res.statusCode,
      ip: req.ip || req.socket.remoteAddress || 'unknown',
    };

    const line = JSON.stringify(entry);
    fs.appendFile(getAuditLogFile(), line + '\n').catch(() => {});

    return originalJson(body);
  };

  next();
}
