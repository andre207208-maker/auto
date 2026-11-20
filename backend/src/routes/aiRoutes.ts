import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { aiProviderManager } from '../services/aiProviderManager.js';

const router = Router();
router.use(requireAuth);

const generateSchema = z.object({
  prompt: z.string().min(1).max(25000),
  systemInstruction: z.string().max(5000).optional(),
  preferredProvider: z.enum(['gemini', 'openrouter', 'apinex', 'custom']).optional(),
  model: z.string().max(150).optional(),
  jsonMode: z.boolean().optional(),
  maxTokens: z.number().int().min(64).max(16000).optional(),
});

router.get(
  '/providers/health',
  asyncHandler(async (_req, res) => {
    res.json({
      providers: aiProviderManager.getProvidersHealth(),
    });
  })
);

router.post(
  '/generate',
  asyncHandler(async (req, res) => {
    const input = generateSchema.parse(req.body);
    const result = await aiProviderManager.generateWithFailover(input);
    res.json(result);
  })
);

export default router;
