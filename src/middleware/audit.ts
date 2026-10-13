import { Request, Response, NextFunction } from 'express';
import type { AuthUser } from './auth';
import { writeAuditEntry } from '../services/auditLog';

function getUserFromResponse(res: Response): string {
  return (res.locals.user as AuthUser | undefined)?.email || 'anonymous';
}

function describeAction(
  method: string,
  fullPath: string,
  body?: Record<string, unknown>,
  query?: Record<string, unknown>
): string {
  // Split into segments: ['', 'api', 'apps', appId, resource, id, action, ...]
  //                   or: ['', 'api', 'admin-users', ...]
  const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
  const seg = fullPath.split('/').filter(Boolean);
  const force = query?.force === 'true' || body?.force === true;
  const forceTag = force ? ' (force=true)' : '';
  // seg[0] = 'api', seg[1] = 'apps'|'admin-users', seg[2] = appId, seg[3] = resource, seg[4] = id, seg[5] = action

  // App operations: /api/apps, /api/apps/:appId, /api/apps/:appId/registry/test
  if (seg[1] === 'apps' && !seg[3]) {
    if (method === 'POST' && !seg[2]) return 'create app';
    if (method === 'PUT' && seg[2]) return `update app ${seg[2]}`;
    if (method === 'DELETE' && seg[2]) return `delete app ${seg[2]}${forceTag}`;
  }
  if (seg[1] === 'apps' && seg[3] === 'registry' && seg[4] === 'test' && method === 'POST') {
    return 'test registry';
  }

  // Tenant operations: /api/apps/:appId/tenants[/:id[/action]]
  if (seg[3] === 'tenants') {
    const id = seg[4];
    const action = seg[5];
    const keepDataTag = query?.keepData === 'true' ? ' (keepData=true)' : '';
    if (!id && method === 'POST') return `create tenant ${body?.tenantId || ''}`;
    if (id && !action && method === 'PATCH') return `update tenant ${id}`;
    if (id && !action && method === 'DELETE') return `delete tenant ${id}${keepDataTag}`;
    if (id && action === 'start' && method === 'POST') return `start tenant ${id}`;
    if (id && action === 'stop' && method === 'POST') return `stop tenant ${id}`;
    if (id && action === 'restart' && method === 'POST') return `restart tenant ${id}`;
    if (id && action === 'access-token' && method === 'POST') return `access tenant ${id}`;
  }

  // Env var operations: /api/apps/:appId/env-vars[/:key] or .../env-vars/tenants/:id/overrides[/:key]
  if (seg[3] === 'env-vars') {
    // Override operations: .../env-vars/tenants/:id/overrides[/:key]
    if (seg[4] === 'tenants' && seg[6] === 'overrides') {
      const tenantId = seg[5];
      if (method === 'POST') return `set override ${body?.key || ''} for ${tenantId}`;
      if (method === 'DELETE' && seg[7]) return `delete override ${decode(seg[7])} for ${tenantId}`;
    }
    // Direct env var operations
    if (!seg[4] && method === 'POST') return `set env var ${body?.key || ''}`;
    if (seg[4] && seg[4] !== 'tenants' && method === 'DELETE') return `delete env var ${decode(seg[4])}`;
  }

  // Backup operations: /api/apps/:appId/backups[/...]
  if (seg[3] === 'backups') {
    const sub = seg[4];
    if (!sub && method === 'POST') return `create backup for ${body?.tenantId || ''}`;
    if (sub === 'init' && method === 'POST') return 'init backup repo';
    if (sub === 'unlock' && method === 'POST') return 'unlock backup repo';
    if (sub === 'all' && method === 'POST') return 'backup all tenants';
    if (sub === 'prune' && method === 'POST') return 'prune backups';
    if (sub && seg[5] === 'restore' && method === 'POST') return `restore backup to ${body?.tenantId || ''}`;
    if (sub && seg[5] === 'create-tenant' && method === 'POST') return `clone backup to new tenant ${body?.tenantId || ''}`;
    if (sub && !seg[5] && method === 'DELETE') return `delete backup ${sub}`;
  }

  // Admin user operations: /api/admin-users[/:email]
  if (seg[1] === 'admin-users') {
    if (!seg[2] && method === 'POST') return `add admin ${body?.email || ''}`;
    if (seg[2] && method === 'DELETE') return `remove admin ${decode(seg[2])}`;
    if (seg[2] && method === 'PATCH') return `change role of ${decode(seg[2])} to ${body?.role || ''}`;
  }

  return `${method} ${fullPath}`;
}

export function auditLog(req: Request, res: Response, next: NextFunction) {
  // Only audit state-changing requests
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const originalJson = res.json.bind(res);
  res.json = function (body: unknown) {
    const fullPath = req.baseUrl + req.path;
    const query = req.query as Record<string, unknown>;
    const force = query?.force === 'true' || req.body?.force === true;
    writeAuditEntry({
      user: getUserFromResponse(res),
      action: describeAction(req.method, fullPath, req.body, query),
      method: req.method,
      path: fullPath,
      query: Object.keys(query || {}).length > 0 ? query : undefined,
      body: req.body,
      force,
      status: res.statusCode,
      ip: req.ip || req.socket.remoteAddress || 'unknown',
    });

    return originalJson(body);
  };

  next();
}
