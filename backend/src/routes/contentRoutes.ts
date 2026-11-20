import { Hono } from 'hono';
import { z } from 'zod';
import { getPipelineRunById, listPostRecords } from '../db/repositories.js';
import { AppVariables, requireAuth } from '../middleware/auth.js';
import { researchTopic } from '../services/researchService.js';
import { enqueueTask } from '../services/taskQueueService.js';
import { WorkerEnv } from '../types/index.js';
import { AppError } from '../utils/errors.js';
import { startAutonomousPipeline } from '../workers/publishWorker.js';

const contentRoutes = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();
contentRoutes.use('*', requireAuth);

const researchSchema = z.object({
  niche: z.string().min(2).max(200),
  seedKeyword: z.string().max(200).optional(),
  language: z.string().max(60).optional(),
  targetAudience: z.string().max(300).optional(),
  preferredProvider: z.enum(['gemini', 'openrouter', 'apinex', 'custom']).optional(),
  async: z.boolean().optional(),
});

const generateArticleSchema = z.object({
  topic: z.string().min(3).max(300),
  primaryKeyword: z.string().min(2).max(150),
  secondaryKeywords: z.array(z.string().max(120)).max(20).optional(),
  language: z.string().max(60).optional(),
  tone: z.string().max(200).optional(),
  targetWordCount: z.number().int().min(300).max(5000).optional(),
  preferredProvider: z.enum(['gemini', 'openrouter', 'apinex', 'custom']).optional(),
});

const pipelineSchema = z.object({
  niche: z.string().min(2).max(200),
  seedKeyword: z.string().max(200).optional(),
  blogId: z.string().max(120).optional(),
  language: z.string().max(60).optional(),
  tone: z.string().max(200).optional(),
  publishAsDraft: z.boolean().optional(),
  injectAds: z.boolean().optional(),
  preferredProvider: z.enum(['gemini', 'openrouter', 'apinex', 'custom']).optional(),
  idempotencyKey: z.string().max(120).optional(),
});

contentRoutes.post('/research', async (c) => {
  const input = researchSchema.parse(await c.req.json());
  if (input.async) {
    const queued = await enqueueTask(c.env, {
      type: 'RESEARCH_TOPIC',
      createdBy: c.get('principal')?.uid || 'api',
      payload: input,
    });
    return c.json({ queued: true, task: queued.task }, 202);
  }
  const research = await researchTopic(c.env, input);
  return c.json({ research });
});

// Enqueues article generation asynchronously via Cloudflare Queues to respect Free plan CPU/wall limits
contentRoutes.post('/generate', async (c) => {
  const input = generateArticleSchema.parse(await c.req.json());
  const queued = await enqueueTask(c.env, {
    type: 'GENERATE_ARTICLE',
    createdBy: c.get('principal')?.uid || 'api',
    payload: input,
  });
  return c.json({ queued: true, task: queued.task }, 202);
});

// Always executes asynchronously as a 3-stage Queue pipeline (Research -> Generate -> SEO/Ads/Blogger)
contentRoutes.post('/publish-pipeline', async (c) => {
  const input = pipelineSchema.parse(await c.req.json());
  const started = await startAutonomousPipeline(c.env, {
    ...input,
    triggeredBy: c.get('principal')?.uid || 'api',
  });
  return c.json(
    {
      queued: true,
      pipeline: started.pipeline,
      initialTaskId: started.initialTaskId,
    },
    202
  );
});

contentRoutes.get('/pipelines/:pipelineId', async (c) => {
  const run = await getPipelineRunById(c.env.DB, c.req.param('pipelineId'));
  if (!run) {
    throw new AppError('Pipeline run not found', 404, 'PIPELINE_NOT_FOUND');
  }
  return c.json({ pipeline: run });
});

contentRoutes.get('/posts', async (c) => {
  const limitParam = c.req.query('limit');
  const limit = limitParam ? Number(limitParam) : 25;
  const posts = await listPostRecords(c.env.DB, limit);
  return c.json({ posts });
});

export default contentRoutes;
