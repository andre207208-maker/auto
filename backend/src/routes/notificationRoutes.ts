import { Hono } from 'hono';
import { z } from 'zod';
import { AppVariables, requireAuth } from '../middleware/auth.js';
import {
  listNotifications,
  registerDeviceToken,
  sendNotification,
  unregisterDeviceToken,
} from '../services/fcmService.js';
import { WorkerEnv } from '../types/index.js';

const notificationRoutes = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();
notificationRoutes.use('*', requireAuth);

notificationRoutes.get('/', async (c) => {
  const limitParam = c.req.query('limit');
  const limit = limitParam ? Number(limitParam) : 30;
  const notifications = await listNotifications(c.env, limit);
  return c.json({ notifications });
});

notificationRoutes.post('/tokens/register', async (c) => {
  const body = z
    .object({
      token: z.string().min(10),
      deviceName: z.string().max(120).optional(),
      platform: z.string().max(40).optional(),
    })
    .parse(await c.req.json());

  await registerDeviceToken(c.env, {
    token: body.token,
    uid: c.get('principal')?.uid || 'unknown',
    deviceName: body.deviceName,
    platform: body.platform,
  });

  return c.json({ registered: true }, 201);
});

notificationRoutes.post('/tokens/unregister', async (c) => {
  const body = z.object({ token: z.string().min(10) }).parse(await c.req.json());
  await unregisterDeviceToken(c.env, body.token);
  return c.json({ unregistered: true });
});

notificationRoutes.post('/send', async (c) => {
  const body = z
    .object({
      title: z.string().min(1).max(160),
      body: z.string().min(1).max(1000),
      topic: z.string().max(120).optional(),
      data: z.record(z.string()).optional(),
    })
    .parse(await c.req.json());

  const result = await sendNotification(c.env, body);
  return c.json(result);
});

export default notificationRoutes;
