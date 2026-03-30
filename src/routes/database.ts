import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { getDatabaseAdapter } from '../adapters/database';

const router = Router();

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
  const db = getDatabaseAdapter();
  const databases = await db.getDatabasesWithDetails();
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
