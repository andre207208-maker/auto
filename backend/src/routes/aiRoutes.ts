import { Hono } from 'hono';
import { z } from 'zod';
import { AppVariables, requireAuth } from '../middleware/auth.js';
import {
  generateWithFailover,
  getProviderPriorityOrder,
  getProvidersHealth,
  resetProvidersHealth,
  setProviderPriorityOrder,
} from '../services/aiProviderManager.js';
import { WorkerEnv } from '../types/index.js';
import { sanitizePlainText } from '../utils/sanitize.js';

const aiRoutes = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();
aiRoutes.use('*', requireAuth);

const providerEnum = z.enum(['gemini', 'openrouter', 'apinex', 'custom']);

const generateSchema = z.object({
  prompt: z.string().min(1).max(25000),
  systemInstruction: z.string().max(5000).optional(),
  preferredProvider: providerEnum.optional(),
  model: z.string().max(150).optional(),
  jsonMode: z.boolean().optional(),
  maxTokens: z.number().int().min(64).max(16000).optional(),
});

const prioritySchema = z.object({
  order: z.array(providerEnum).min(1).max(4),
});

aiRoutes.get('/providers/health', async (c) => {
  const [providers, priorityOrder] = await Promise.all([
    getProvidersHealth(c.env),
    getProviderPriorityOrder(c.env),
  ]);
  return c.json({ providers, priorityOrder });
});

aiRoutes.get('/providers/priority', async (c) => {
  const order = await getProviderPriorityOrder(c.env);
  return c.json({ priorityOrder: order });
});

aiRoutes.put('/providers/priority', async (c) => {
  const input = prioritySchema.parse(await c.req.json());
  const updatedBy = c.get('principal')?.uid || 'api';
  const priorityOrder = await setProviderPriorityOrder(c.env, input.order, updatedBy);
  return c.json({ priorityOrder, updated: true });
});

aiRoutes.post('/providers/reset-health', async (c) => {
  const providers = await resetProvidersHealth(c.env);
  return c.json({ providers, reset: true });
});

aiRoutes.post('/generate', async (c) => {
  const input = generateSchema.parse(await c.req.json());
  const result = await generateWithFailover(c.env, {
    ...input,
    prompt: sanitizePlainText(input.prompt, 25000),
    systemInstruction: input.systemInstruction
      ? sanitizePlainText(input.systemInstruction, 5000)
      : undefined,
  });
  return c.json(result);
});

export default aiRoutes;
