import { Router } from 'express';
import { requireAuth, requireSchedulerOrAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { listRecentSystemLogs } from '../services/firestoreService.js';
import { runAnalyticsSyncJob } from '../workers/analyticsWorker.js';

const router = Router();

router.post(
  '/analytics/daily',
  requireSchedulerOrAuth,
  asyncHandler(async (_req, res) => {
    const summary = await runAnalyticsSyncJob('daily');
    res.json({ summary });
  })
);

router.post(
  '/analytics/weekly',
  requireSchedulerOrAuth,
  asyncHandler(async (_req, res) => {
    const summary = await runAnalyticsSyncJob('weekly');
    res.json({ summary });
  })
);

router.get(
  '/logs',
  requireAuth,
  asyncHandler(async (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const logs = await listRecentSystemLogs(limit);
    res.json({ logs });
  })
);

export default router;
