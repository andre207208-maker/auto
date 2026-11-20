import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireSchedulerOrAuth } from '../middleware/auth.js';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { enqueueTask, getTaskById, listTasks } from '../services/taskQueueService.js';
import { TaskStatus } from '../types/index.js';
import { executeTaskById, processDueRetryQueue } from '../workers/taskWorker.js';

const router = Router();

const enqueueSchema = z.object({
  type: z.enum([
    'GENERATE_AND_PUBLISH',
    'RESEARCH_TOPIC',
    'SYNC_ANALYTICS_DAILY',
    'SYNC_ANALYTICS_WEEKLY',
    'SEND_NOTIFICATION',
    'INDEX_URL_CHECK',
  ]),
  payload: z.record(z.unknown()),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  delaySeconds: z.number().int().min(0).max(86400).optional(),
});

router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === 'string' ? (req.query.status as TaskStatus) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const tasks = await listTasks({ status, limit });
    res.json({ tasks });
  })
);

router.get(
  '/:taskId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const task = await getTaskById(req.params.taskId);
    if (!task) {
      throw new AppError('Task not found', 404, 'TASK_NOT_FOUND');
    }
    res.json({ task });
  })
);

router.post(
  '/enqueue',
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = enqueueSchema.parse(req.body);
    const task = await enqueueTask({
      ...input,
      createdBy: req.principal?.uid || 'api',
    });
    res.status(202).json({ task });
  })
);

// Cloud Tasks HTTP target callback
router.post(
  '/execute',
  requireSchedulerOrAuth,
  asyncHandler(async (req, res) => {
    const body = z.object({ taskId: z.string().min(1) }).parse(req.body);
    const outcome = await executeTaskById(body.taskId);
    res.json(outcome);
  })
);

// Cloud Scheduler periodic sweep for queued/retrying tasks
router.post(
  '/process-retries',
  requireSchedulerOrAuth,
  asyncHandler(async (req, res) => {
    const limit = req.body?.limit ? Number(req.body.limit) : 15;
    const result = await processDueRetryQueue(limit);
    res.json(result);
  })
);

export default router;
