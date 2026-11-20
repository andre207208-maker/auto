import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
  registerDeviceToken,
  sendNotification,
  unregisterDeviceToken,
} from '../services/fcmService.js';

const router = Router();
router.use(requireAuth);

router.post(
  '/tokens/register',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        token: z.string().min(10),
        deviceName: z.string().max(120).optional(),
        platform: z.string().max(40).optional(),
      })
      .parse(req.body);

    await registerDeviceToken({
      token: body.token,
      uid: req.principal?.uid || 'unknown',
      deviceName: body.deviceName,
      platform: body.platform,
    });

    res.status(201).json({ registered: true });
  })
);

router.post(
  '/tokens/unregister',
  asyncHandler(async (req, res) => {
    const body = z.object({ token: z.string().min(10) }).parse(req.body);
    await unregisterDeviceToken(body.token);
    res.json({ unregistered: true });
  })
);

router.post(
  '/send',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        title: z.string().min(1).max(160),
        body: z.string().min(1).max(1000),
        topic: z.string().max(120).optional(),
        data: z.record(z.string()).optional(),
      })
      .parse(req.body);

    const result = await sendNotification(body);
    res.json(result);
  })
);

export default router;
