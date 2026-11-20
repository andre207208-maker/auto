import { Hono } from 'hono';
import { z } from 'zod';
import { AppVariables, requireAuth, requireSchedulerOrAuth } from '../middleware/auth.js';
import { enqueueTask, getTaskById, listTasks } from '../services/taskQueueService.js';
import { TaskStatus, WorkerEnv } from '../types/index.js';
import { AppError } from '../utils/errors.js';
import { executeTaskById, processDueRetryQueue } from '../workers/taskWorker.js';

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
    'SEND_NOTIFICATION',
    'INDEX_URL_CHECK',
  ]),
  payload: z.record(z.unknown()),
  idempotencyKey: z.string().max(150).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  delaySeconds: z.number().int().min(0).max(86400).optional(),
});

taskRoutes.get('/', requireAuth, async (c) => {
  const statusQuery = c.req.query('status') as TaskStatus | undefined;
  const limitParam = c.req.query('limit');
  const limit = limitParam ? Number(limitParam) : 50;
  const tasks = await listTasks(c.env, { status: statusQuery, limit });
  return c.json({ tasks });
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
    },
    queued.duplicate ? 200 : 202
  );
});

taskRoutes.post('/execute', requireSchedulerOrAuth, async (c) => {
  const body = z.object({ taskId: z.string().min(1) }).parse(await c.req.json());
  const outcome = await executeTaskById(c.env, body.taskId);
  return c.json(outcome);
});

taskRoutes.post('/process-retries', requireSchedulerOrAuth, async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const limit = typeof raw?.limit === 'number' ? raw.limit : 10;
  const result = await processDueRetryQueue(c.env, limit);
  return c.json(result);
});

export default taskRoutes;
