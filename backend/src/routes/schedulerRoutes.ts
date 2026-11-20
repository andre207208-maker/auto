import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireSchedulerOrAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
  createOrUpdateCampaign,
  deleteCampaign,
  listCampaigns,
  runSchedulerTick,
} from '../services/schedulerService.js';

const router = Router();

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

router.get(
  '/campaigns',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const campaigns = await listCampaigns();
    res.json({ campaigns });
  })
);

router.post(
  '/campaigns',
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = campaignSchema.parse(req.body);
    const campaign = await createOrUpdateCampaign(input);
    res.status(201).json({ campaign });
  })
);

router.delete(
  '/campaigns/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    await deleteCampaign(req.params.id);
    res.status(204).send();
  })
);

// Invoked by Google Cloud Scheduler (or manually by authenticated user)
router.post(
  '/tick',
  requireSchedulerOrAuth,
  asyncHandler(async (req, res) => {
    const result = await runSchedulerTick(req.principal?.uid || 'cloud-scheduler');
    res.json(result);
  })
);

export default router;
