import { Router } from 'express';
import * as fs from 'fs/promises';
import * as path from 'path';
import { asyncHandler } from '../utils/asyncHandler';
import { getDatabaseAdapter } from '../adapters/database';
import { listApps } from '../services/app';
import { getAppsDir } from '../config';
import { parseEnv } from '../utils/env';

const router = Router();

/**
 * Collect all known tenant DB_NAMEs from .env files across all apps.
 * A database is "tenant" if its name matches any known tenant's DB_NAME.
 */
async function collectTenantDbNames(): Promise<Set<string>> {
  const dbNames = new Set<string>();
  const appsDir = getAppsDir();

  try {
    const apps = await listApps();
    for (const app of apps) {
      const tenantsDir = path.join(appsDir, app.id, 'tenants');
      let dirs: string[];
      try {
        dirs = await fs.readdir(tenantsDir);
      } catch {
        continue;
      }
      for (const dir of dirs) {
        const envPath = path.join(tenantsDir, dir, '.env');
        try {
          const envContent = await fs.readFile(envPath, 'utf-8');
          const env = parseEnv(envContent);
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
  const db = getDatabaseAdapter();
  const info = await db.getServerInfo();
  res.json(info);
}));

// GET /api/database/stats
router.get('/stats', asyncHandler(async (_req, res) => {
  const db = getDatabaseAdapter();
  const stats = await db.getServerStats();
  res.json(stats);
}));

// GET /api/database/databases
router.get('/databases', asyncHandler(async (_req, res) => {
  const [db, tenantDbNames] = [getDatabaseAdapter(), await collectTenantDbNames()];
  const databases = await db.getDatabasesWithDetails();

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
  const db = getDatabaseAdapter();
  const processes = await db.getProcessList();
  res.json(processes);
}));

// POST /api/database/processes/:id/kill
router.post('/processes/:id/kill', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid process ID' });
    return;
  }
  const db = getDatabaseAdapter();
  await db.killProcess(id);
  res.json({ success: true });
}));

export default router;
