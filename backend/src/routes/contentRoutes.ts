import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { generateArticle } from '../services/contentGeneratorService.js';
import { researchTopic } from '../services/researchService.js';
import { enqueueTask } from '../services/taskQueueService.js';
import { runAutonomousPublishPipeline } from '../workers/publishWorker.js';

const router = Router();
router.use(requireAuth);

const researchSchema = z.object({
  niche: z.string().min(2).max(200),
  seedKeyword: z.string().max(200).optional(),
  language: z.string().max(60).optional(),
  targetAudience: z.string().max(300).optional(),
  preferredProvider: z.enum(['gemini', 'openrouter', 'apinex', 'custom']).optional(),
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
  async: z.boolean().optional(),
});

router.post(
  '/research',
  asyncHandler(async (req, res) => {
    const input = researchSchema.parse(req.body);
    const result = await researchTopic(input);
    res.json({ research: result });
  })
);

router.post(
  '/generate',
  asyncHandler(async (req, res) => {
    const input = generateArticleSchema.parse(req.body);
    const article = await generateArticle(input);
    res.json({ article });
  })
);

router.post(
  '/publish-pipeline',
  asyncHandler(async (req, res) => {
    const input = pipelineSchema.parse(req.body);
    if (input.async) {
      const task = await enqueueTask({
        type: 'GENERATE_AND_PUBLISH',
        createdBy: req.principal?.uid || 'api',
        payload: input,
      });
      res.status(202).json({ queued: true, task });
      return;
    }

    const result = await runAutonomousPublishPipeline({
      ...input,
      triggeredBy: req.principal?.uid || 'manual_api',
    });
    res.status(201).json({ published: result });
  })
);

export default router;
