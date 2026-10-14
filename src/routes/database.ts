import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { getDatabaseAdapter } from '../adapters/database';
import { listApps } from '../services/app';
import { listTenantDirs, readTenantEnv } from '../services/tenantStore';
import { requireRole } from '../middleware/requireRole';
import { HttpError } from '../utils/httpErrors';

const router = Router();

// Driver messages carry hosts, user names and SQL, and these routes are open to
// every role, so failures are classified into fixed messages; the raw error is
// only logged.
export function classifyDbError(err: any): HttpError {
  const code = String(err?.code ?? '');
  if (/^(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ECONNRESET|EAI_AGAIN|PROTOCOL_CONNECTION_LOST|57P0[1-3]|08.{3})$/.test(code)) {
    return new HttpError(503, 'Database unreachable', { expose: true });
  }
  if (/^(ER_ACCESS_DENIED_ERROR|ER_DBACCESS_DENIED_ERROR|28P01|28000)$/.test(code)) {
    return new HttpError(502, 'Database authentication failed', { expose: true });
  }
  return new HttpError(502, 'Database query failed', { expose: true });
}

async function dbCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    if (err instanceof HttpError) throw err;
    console.error('[database] operation failed:', err);
    throw classifyDbError(err);
  }
}

/**
 * Collect all known tenant DB_NAMEs from .env files across all apps.
 * A database is "tenant" if its name matches any known tenant's DB_NAME.
 */
async function collectTenantDbNames(): Promise<Set<string>> {
  const dbNames = new Set<string>();

  try {
    const apps = await listApps();
    for (const app of apps) {
      for (const { tenantId } of await listTenantDirs(app.id, { onError: () => {} })) {
        try {
          const env = await readTenantEnv(app.id, tenantId);
          if (env.DB_NAME) {
            dbNames.add(env.DB_NAME);
          }
        } catch {
          // Skip tenants without .env
        }
      }
    }
  } catch {
    // Apps directory doesn't exist yet
  }

  return dbNames;
}

// GET /api/database/info
router.get('/info', asyncHandler(async (_req, res) => {
  res.json(await dbCall(() => getDatabaseAdapter().getServerInfo()));
}));

// GET /api/database/stats
router.get('/stats', asyncHandler(async (_req, res) => {
  res.json(await dbCall(() => getDatabaseAdapter().getServerStats()));
}));

// GET /api/database/databases
router.get('/databases', asyncHandler(async (_req, res) => {
  const tenantDbNames = await collectTenantDbNames();
  const databases = await dbCall(() => getDatabaseAdapter().getDatabasesWithDetails());

  // Re-classify using actual tenant DB_NAMEs from .env files
  if (tenantDbNames.size > 0) {
    for (const database of databases) {
      database.isTenantDb = tenantDbNames.has(database.name);
    }
  }

  res.json(databases);
}));

// GET /api/database/processes
router.get('/processes', asyncHandler(async (_req, res) => {
  res.json(await dbCall(() => getDatabaseAdapter().getProcessList()));
}));

// POST /api/database/processes/:id/kill — admin only (can disrupt running workloads).
router.post('/processes/:id/kill', requireRole('admin'), asyncHandler(async (req, res) => {
  const id = parseInt((req.params as Record<string, string>).id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid process ID' });
    return;
  }
  await dbCall(() => getDatabaseAdapter().killProcess(id));
  res.json({ success: true });
}));

export default router;
