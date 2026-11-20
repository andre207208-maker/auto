import { Hono } from 'hono';
import { z } from 'zod';
import { AppVariables, requireAuth } from '../middleware/auth.js';
import { generateWithFailover, getProvidersHealth } from '../services/aiProviderManager.js';
import { WorkerEnv } from '../types/index.js';

const aiRoutes = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();
aiRoutes.use('*', requireAuth);

const generateSchema = z.object({
  prompt: z.string().min(1).max(25000),
  systemInstruction: z.string().max(5000).optional(),
  preferredProvider: z.enum(['gemini', 'openrouter', 'apinex', 'custom']).optional(),
  model: z.string().max(150).optional(),
  jsonMode: z.boolean().optional(),
  maxTokens: z.number().int().min(64).max(16000).optional(),
});

aiRoutes.get('/providers/health', async (c) => {
  const providers = await getProvidersHealth(c.env);
  return c.json({ providers });
});

aiRoutes.post('/generate', async (c) => {
  const input = generateSchema.parse(await c.req.json());
  const result = await generateWithFailover(c.env, input);
  return c.json(result);
});

export default aiRoutes;
