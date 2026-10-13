import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { queryString, queryInt } from '../utils/query';
import { readAuditEntries } from '../services/auditLog';

const router = Router();

// Get recent audit log entries
router.get('/', asyncHandler(async (req, res) => {
  res.json(await readAuditEntries({
    limit: queryInt(req.query.limit, 50, 1, 200),
    user: queryString(req.query.user),
    action: queryString(req.query.action),
  }));
}));

export default router;
