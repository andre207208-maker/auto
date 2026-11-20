import { Hono } from 'hono';
import { z } from 'zod';
import { AppVariables, requireAuth } from '../middleware/auth.js';
import { getAgentState, setAgentState } from '../services/agentControlService.js';
import { WorkerEnv } from '../types/index.js';

const agentRoutes = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();
agentRoutes.use('*', requireAuth);

const reasonSchema = z.object({
  reason: z.string().max(300).optional(),
});

agentRoutes.get('/status', async (c) => {
  const agent = await getAgentState(c.env);
  return c.json({ agent });
});

agentRoutes.post('/pause', async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const body = reasonSchema.parse(raw);
  const { agent } = await setAgentState(c.env, {
    status: 'paused',
    emergencyStop: false,
    reason: body.reason || 'Paused by operator',
    updatedBy: c.get('principal')?.uid || 'unknown',
  });
  return c.json({ agent });
});

agentRoutes.post('/resume', async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const body = reasonSchema.parse(raw);
  const { agent } = await setAgentState(c.env, {
    status: 'running',
    emergencyStop: false,
    reason: body.reason || 'Resumed by operator',
    updatedBy: c.get('principal')?.uid || 'unknown',
  });
  return c.json({ agent });
});

agentRoutes.post('/emergency-stop', async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const body = reasonSchema.parse(raw);
  const { agent, cancelledTasks } = await setAgentState(c.env, {
    status: 'stopped',
    emergencyStop: true,
    reason: body.reason || 'Emergency stop triggered',
    updatedBy: c.get('principal')?.uid || 'unknown',
  });
  return c.json({
    agent,
    cancelledTasks,
    message: 'Emergency stop activated. Pending queued tasks and pipelines cancelled.',
  });
});

export default agentRoutes;
