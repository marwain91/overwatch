import { Router } from 'express';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getDataDir } from '../config';
import { asyncHandler } from '../utils/asyncHandler';
import { queryString, queryInt } from '../utils/query';

const router = Router();

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

// Get recent audit log entries
router.get('/', asyncHandler(async (req, res) => {
  const logFile = path.join(getDataDir(), 'audit.log');
  const limit = queryInt(req.query.limit, 50, 1, 200);
  const user = queryString(req.query.user);
  const action = queryString(req.query.action);

  let entries: AuditEntry[] = [];

  try {
    const content = await fs.readFile(logFile, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    // Parse from newest to oldest (last lines are most recent)
    for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
      try {
        const entry: AuditEntry = JSON.parse(lines[i]);

        // Apply filters
        if (user && !entry.user.toLowerCase().includes(user.toLowerCase())) continue;
        if (action && !entry.action.toLowerCase().includes(action.toLowerCase())) continue;

        // Strip request body from response for privacy
        const { body, ...safeEntry } = entry;
        entries.push(safeEntry as AuditEntry);
      } catch {
        // Skip malformed lines
      }
    }
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      // No audit log yet — return empty
    } else {
      throw err;
    }
  }

  res.json(entries);
}));

export default router;
