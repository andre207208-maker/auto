import { Hono } from 'hono';
import { z } from 'zod';
import { AppVariables, requireAuth, requireSchedulerOrAuth } from '../middleware/auth.js';
import {
  createOrUpdateCampaign,
  deleteCampaign,
  listCampaigns,
  runSchedulerTick,
} from '../services/schedulerService.js';
import { WorkerEnv } from '../types/index.js';

const schedulerRoutes = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

const campaignSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(2).max(140),
  niche: z.string().min(2).max(200),
  blogId: z.string().min(2).max(120),
  enabled: z.boolean().default(true),
  cronExpression: z.string().default('0 */6 * * *'),
  postsPerDay: z.number().int().min(1).max(24).default(2),
  publishAsDraft: z.boolean().default(false),
  injectAds: z.boolean().default(true),
  preferredProvider: z.enum(['gemini', 'openrouter', 'apinex', 'custom']).optional(),
  language: z.string().default('English'),
  targetKeywords: z.array(z.string().max(120)).default([]),
});

schedulerRoutes.get('/campaigns', requireAuth, async (c) => {
  const campaigns = await listCampaigns(c.env);
  return c.json({ campaigns });
});

schedulerRoutes.post('/campaigns', requireAuth, async (c) => {
  const input = campaignSchema.parse(await c.req.json());
  const campaign = await createOrUpdateCampaign(c.env, input);
  return c.json({ campaign }, 201);
});

schedulerRoutes.delete('/campaigns/:id', requireAuth, async (c) => {
  const id = c.req.param('id') || '';
  await deleteCampaign(c.env, id);
  return c.body(null, 204);
});

schedulerRoutes.post('/tick', requireSchedulerOrAuth, async (c) => {
  const result = await runSchedulerTick(c.env, c.get('principal')?.uid || 'scheduler');
  return c.json(result);
});

export default schedulerRoutes;
