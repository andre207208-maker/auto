import { Hono } from 'hono';
import { listRecentSystemLogs } from '../db/repositories.js';
import { AppVariables, requireAuth, requireSchedulerOrAuth } from '../middleware/auth.js';
import { WorkerEnv } from '../types/index.js';
import { runAnalyticsSyncJob } from '../workers/analyticsWorker.js';

const workerRoutes = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

workerRoutes.post('/analytics/daily', requireSchedulerOrAuth, async (c) => {
  const summary = await runAnalyticsSyncJob(c.env, 'daily');
  return c.json({ summary });
});

workerRoutes.post('/analytics/weekly', requireSchedulerOrAuth, async (c) => {
  const summary = await runAnalyticsSyncJob(c.env, 'weekly');
  return c.json({ summary });
});

workerRoutes.get('/logs', requireAuth, async (c) => {
  const limitParam = c.req.query('limit');
  const limit = limitParam ? Number(limitParam) : 50;
  const logs = await listRecentSystemLogs(c.env.DB, limit);
  return c.json({ logs });
});

export default workerRoutes;
