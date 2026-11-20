import { Hono } from 'hono';
import { z } from 'zod';
import { AppVariables, requireAuth, requireSchedulerOrAuth } from '../middleware/auth.js';
import {
  enqueueTask,
  getQueueStats,
  getTaskById,
  listTasks,
} from '../services/taskQueueService.js';
import { TaskStatusFilter, WorkerEnv } from '../types/index.js';
import { AppError } from '../utils/errors.js';
import { executeTaskById, processD1JobBatch } from '../workers/taskWorker.js';

const taskRoutes = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

const enqueueSchema = z.object({
  type: z.enum([
    'PIPELINE_RESEARCH',
    'PIPELINE_GENERATE',
    'PIPELINE_OPTIMIZE_AND_PUBLISH',
    'GENERATE_AND_PUBLISH',
    'RESEARCH_TOPIC',
    'GENERATE_ARTICLE',
    'SYNC_ANALYTICS_DAILY',
    'SYNC_ANALYTICS_WEEKLY',
    'SEO_AUDIT_BATCH',
    'CONTENT_UPDATE_CHECK',
    'SEND_NOTIFICATION',
    'INDEX_URL_CHECK',
  ]),
  payload: z.record(z.unknown()),
  idempotencyKey: z.string().max(150).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  delaySeconds: z.number().int().min(0).max(86400).optional(),
  priority: z.number().int().min(1).max(10).optional(),
});

taskRoutes.get('/', requireAuth, async (c) => {
  const statusQuery = c.req.query('status') as TaskStatusFilter | undefined;
  const limitParam = c.req.query('limit');
  const limit = limitParam ? Number(limitParam) : 50;
  const [tasks, summary] = await Promise.all([
    listTasks(c.env, { status: statusQuery, limit }),
    getQueueStats(c.env),
  ]);
  return c.json({ tasks, summary });
});

taskRoutes.get('/stats', requireAuth, async (c) => {
  const stats = await getQueueStats(c.env);
  return c.json({ stats });
});

taskRoutes.get('/:taskId', requireAuth, async (c) => {
  const taskId = c.req.param('taskId') || '';
  const task = await getTaskById(c.env, taskId);
  if (!task) {
    throw new AppError('Task not found', 404, 'TASK_NOT_FOUND');
  }
  return c.json({ task });
});

taskRoutes.post('/enqueue', requireAuth, async (c) => {
  const input = enqueueSchema.parse(await c.req.json());
  const queued = await enqueueTask(c.env, {
    ...input,
    createdBy: c.get('principal')?.uid || 'api',
  });
  return c.json(
    {
      task: queued.task,
      duplicate: queued.duplicate,
      dispatchedToQueue: queued.dispatchedToQueue,
      queueBackend: queued.queueBackend,
    },
    queued.duplicate ? 200 : 202
  );
});

taskRoutes.post('/execute', requireSchedulerOrAuth, async (c) => {
  const body = z.object({ taskId: z.string().min(1) }).parse(await c.req.json());
  const outcome = await executeTaskById(c.env, body.taskId, 'manual-execute');
  return c.json(outcome);
});

taskRoutes.post('/process-retries', requireSchedulerOrAuth, async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const limit = typeof raw?.limit === 'number' ? raw.limit : 3;
  const result = await processD1JobBatch(c.env, { limit, workerId: 'manual-sweep' });
  return c.json(result);
});

taskRoutes.post('/process', requireSchedulerOrAuth, async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const limit = typeof raw?.limit === 'number' ? raw.limit : 3;
  const result = await processD1JobBatch(c.env, { limit, workerId: 'manual-sweep' });
  return c.json(result);
});

export default taskRoutes;
